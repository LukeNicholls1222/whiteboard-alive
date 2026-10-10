// Pulley (Atwood machine): a wheel with a rope over it and a weight on each side. The heavier weight falls.
//
// Geometry comes only from the contours and the ink mask:
//   wheel  = AI 'wheel' contour, else the topmost closed contour that fits a circle, else the thickest blob near
//            the top, else (open circle, e.g. pencil not closed) a circle found in the ink of the upper drawing
//   junk   = thin strokes on the photo border (paper edge, table), tiny specks (dirt, creases) and strokes nowhere
//            near the wheel: never move
//   ropes/weights = everything that is not the wheel, below the wheel centre, split left/right of the axle
//     per connected stroke (so a weight drawn across the centre line stays whole).
//     On each side the weight starts at the first row that is "wide" (rope rows are thin), so a rope that
//     is drawn joined to its weight (one contour) still separates cleanly.
//
// Physics: an ideal Atwood machine has one degree of freedom (rope length is constant, L_left + L_right = const).
// Instead of fighting soft Matter constraints we integrate that one coordinate exactly every step
// (a = g * (mL - mR) / (mL + mR)) and pin both bodies to it (vertical motion only). Gravity is read from the
// engine each step, so slider/voice/moon-mode gravity changes apply instantly.

import Matter from 'matter-js';
import type { Contour, Point, SceneBuilder, SceneInput, Sprite, ValueSource } from '../types';
import { STEP_ACCEL, STEP_MS } from '../sim';
import { noteFor } from '../units';
import { buildFallback } from './fallback';
import { contourMask, cutSprite, deepestPoint, eraseFromPaper, maskBounds, roleOf } from './common';

/** Ratio applied when both weights are (nearly) equal, so the scene always moves. */
const TIE_BREAK_RATIO = 1.25;
/** Masses closer than this relative difference count as equal. */
const TIE_TOLERANCE = 0.08;
/** Wheel disk removed from the rope/weight mask, as a multiple of the wheel radius. */
const WHEEL_CLEAR = 1.15;
/** A row is part of a weight (not rope) when its width is at least this fraction of the widest row on that side. */
const WEIGHT_ROW_FRACTION = 0.5;
/** Steps to hold still at the end of the run before resetting (1.5 s at 60 fps, keeps the demo looping). */
const HOLD_STEPS = 90;
/** Gap kept between a rising weight and the wheel, px. */
const WHEEL_GAP = 4;
const MIN_TRAVEL = 30;
/**
 * Heavier : lighter mass is capped at this ratio. Drawn areas can differ 5-10x, which would make the
 * heavy side drop almost in free fall; 3:1 still reads clearly as "heavier wins" (a = g/2).
 */
const MAX_MASS_RATIO = 3;
/**
 * How long the fall should take on screen at Earth gravity, seconds. The scene integrates its own gravity,
 * slowed down by `scale` (≤ 1) so the full travel takes this long whatever the masses; lower gravity (moon mode)
 * still slows it down further, as it should. The slowdown is reported as `gravityScale`, so units.ts plays the
 * physical time at the matching slow-motion factor and every readout still says a = g(m1 - m2)/(m1 + m2).
 */
const TARGET_FALL_S = 3.5;
/** Default Matter scale: px per metre at which 9.8 m/s² is engine gravity 1. Never move faster than that. */
const DEFAULT_PX_PER_M = 1000 / 9.8;
/** Contours closer than this (fraction of the image size) to the photo border are paper edges / table, not ink. */
const BORDER_FRAC = 0.03;
/** A stroke this many times longer than it is thick is a line (bar, edge), not a weight. */
const THIN_ASPECT = 6;
/**
 * A stroke with less ink and less area than this fraction of the biggest stroke is a speck (dirt, crease, shadow
 * edge), not part of the machine. It stays in the background. A separately drawn small weight is well above this.
 */
const SPECK_FRAC = 0.03;
/** A separate stroke is a circle when its outline is this close to the best-fit circle (RMS / radius). */
const CIRCLE_RMS = 0.15;
/** Angles sampled when checking how much of a circle is drawn. */
const RING_SAMPLES = 72;
/** At least this much of the circle must have ink for it to count as the drawn wheel (an open circle still passes). */
const MIN_RING_COVER = 0.6;
/** contourMask() margin: the filled disk is this much bigger than the drawn circle. */
const JOIN_MARGIN = 4;

interface Side {
  weight: Uint8Array;
  rope: Uint8Array;
  weightBox: { x: number; y: number; w: number; h: number };
  ropeBox: { x: number; y: number; w: number; h: number } | null;
  /** Rope x where it leaves the wheel (used when no rope ink was found). */
  ropeX: number;
  pixels: number;
}

const isRoundBox = (c: Contour) => {
  const r = c.bbox.w / Math.max(1, c.bbox.h);
  return r > 0.6 && r < 1.6;
};

/** Least-squares (Kåsa) circle through the points; `rms` = RMS distance of the points from it, px. */
function fitCircle(pts: Point[]): { center: Point; r: number; rms: number } | null {
  const n = pts.length;
  if (n < 5) return null;
  let mx = 0, my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (suu * b2 - suv * b1) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const center = { x: mx + uc, y: my + vc };
  let e = 0;
  for (const p of pts) e += (Math.hypot(p.x - center.x, p.y - center.y) - r) ** 2;
  return { center, r, rms: Math.sqrt(e / n) };
}

/** A separate stroke counts as the wheel only if its outline really is a circle (not a whole drawing that happens to be roundish). */
function isCircleStroke(c: Contour) {
  if (!isRoundBox(c)) return false;
  const fit = fitCircle(c.points);
  return !!fit && fit.r > 6 && fit.rms < fit.r * CIRCLE_RMS;
}

/** Ring tolerance (px) used when matching a circle against the ink. */
const ringTol = (r: number) => Math.max(4, r * 0.12);

/** Fraction of the circle (c, r) that has ink on it (within ringTol), sampled at RING_SAMPLES angles. */
function ringCoverage(ink: Uint8Array, W: number, H: number, c: Point, r: number): number {
  const tol = Math.round(ringTol(r));
  let hit = 0;
  for (let k = 0; k < RING_SAMPLES; k++) {
    const a = (k / RING_SAMPLES) * Math.PI * 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    for (let d = -tol; d <= tol; d++) {
      const x = Math.round(c.x + (r + d) * cos), y = Math.round(c.y + (r + d) * sin);
      if (x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x]) {
        hit++;
        break;
      }
    }
  }
  return hit / RING_SAMPLES;
}

/**
 * The drawn wheel as a circle in the ink, even when it is open (pencil not closed, a gap where the rope leaves)
 * or joined to the ropes: a coarse circle Hough transform over the upper part of the drawing gives candidates,
 * each is scored by how much of its ring has ink, and the best one is refined with a least-squares fit.
 */
function circleInInk(ink: Uint8Array, W: number, H: number, box: { x: number; y: number; w: number; h: number }) {
  const f = Math.max(2, Math.round(Math.max(W, H) / 240)); // coarse grid cell, px
  const gw = Math.ceil(W / f), gh = Math.ceil(H / f);
  const y0 = Math.max(0, box.y), y1 = Math.min(H, Math.round(box.y + box.h * 0.6));
  const x0 = Math.max(0, box.x), x1 = Math.min(W, box.x + box.w);
  const pts: number[] = [];
  const seen = new Uint8Array(gw * gh);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (ink[y * W + x]) {
        const g = Math.floor(y / f) * gw + Math.floor(x / f);
        if (!seen[g]) {
          seen[g] = 1;
          pts.push(g);
        }
      }
  if (pts.length < 20) return null;
  const size = Math.max(box.w, box.h);
  const rMin = Math.max(3, Math.round((size * 0.05) / f));
  const rMax = Math.max(rMin + 1, Math.round(Math.min(box.w * 0.45, box.h * 0.35) / f));
  const acc = new Uint16Array(gw * gh);
  const cands: { center: Point; r: number }[] = [];
  for (let r = rMin; r <= rMax; r++) {
    acc.fill(0);
    const n = Math.max(24, Math.round(r * 4.5));
    const dx = new Int32Array(n), dy = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      dx[k] = Math.round(r * Math.cos((k / n) * Math.PI * 2));
      dy[k] = Math.round(r * Math.sin((k / n) * Math.PI * 2));
    }
    let best = 0, bi = -1;
    for (const g of pts) {
      const gx = g % gw, gy = (g - gx) / gw;
      for (let k = 0; k < n; k++) {
        const cx = gx - dx[k], cy = gy - dy[k];
        if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
        const i = cy * gw + cx;
        const v = ++acc[i];
        if (v > best) {
          best = v;
          bi = i;
        }
      }
    }
    if (bi >= 0) cands.push({ center: { x: ((bi % gw) + 0.5) * f, y: (Math.floor(bi / gw) + 0.5) * f }, r: r * f });
  }
  let best: { center: Point; r: number; cover: number } | null = null;
  for (const c of cands) {
    const cover = ringCoverage(ink, W, H, c.center, c.r);
    // Coverage ties (a thick stroke matches at several radii): the larger circle is the wheel's outer edge.
    if (!best || cover > best.cover + 0.03 || (cover > best.cover - 0.03 && c.r > best.r)) best = { ...c, cover };
  }
  if (!best || best.cover < MIN_RING_COVER) return null;
  // Refine on the ink pixels that lie on the found ring.
  const tol = ringTol(best.r);
  const near: Point[] = [];
  const bx0 = Math.max(0, Math.floor(best.center.x - best.r - tol)), bx1 = Math.min(W, Math.ceil(best.center.x + best.r + tol));
  const by0 = Math.max(0, Math.floor(best.center.y - best.r - tol)), by1 = Math.min(H, Math.ceil(best.center.y + best.r + tol));
  for (let y = by0; y < by1; y++)
    for (let x = bx0; x < bx1; x++)
      if (ink[y * W + x] && Math.abs(Math.hypot(x - best.center.x, y - best.center.y) - best.r) <= tol) near.push({ x, y });
  const fit = fitCircle(near);
  if (fit && Math.abs(fit.r - best.r) < tol * 2 && Math.hypot(fit.center.x - best.center.x, fit.center.y - best.center.y) < tol * 2) {
    const cover = ringCoverage(ink, W, H, fit.center, fit.r);
    if (cover >= best.cover - 0.05) return { center: fit.center, r: fit.r, cover };
  }
  return best;
}

function findWheel(input: SceneInput, parts: Contour[], all: Uint8Array) {
  const { width: W, height: H } = input;
  const byRole = parts.filter((c) => roleOf(input, c.id)?.role === 'wheel');
  let separate: Contour | null = null;
  if (byRole.length) {
    const best = byRole.sort((a, b) => b.area - a.area)[0];
    if (isCircleStroke(best)) separate = best;
  } else {
    // No AI hint: topmost round closed stroke in the upper half of the drawing.
    const b = maskBounds(all, W, H);
    const limit = b ? b.y + b.h * 0.55 : H / 2;
    const cands = parts
      .filter((c) => c.hasHole && c.centroid.y < limit && c.bbox.w > 12 && isCircleStroke(c))
      .sort((a, b) => a.centroid.y - b.centroid.y);
    separate = cands[0] ?? null;
  }
  if (separate) {
    const { x, y, w, h } = separate.bbox;
    return { center: { x: x + w / 2, y: y + h / 2 }, radius: (w + h) / 4, contour: separate };
  }
  // Wheel joined to ropes/weights (or not found): thickest point in the top ~45% of the drawing.
  const b = maskBounds(all, W, H) ?? { x: 0, y: 0, w: W, h: H };
  const top = all.slice();
  const cut = Math.round(b.y + b.h * 0.45);
  top.fill(0, Math.max(0, cut) * W);
  const { point, radius } = deepestPoint(top, W, H);
  // That only works for a closed wheel (a filled disk). Check it against the ink; if no drawn circle is there
  // (open circle, wheel drawn as an arc), look for the circle in the ink itself.
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i++) ink[i] = input.ink[i] && all[i] ? 1 : 0;
  const ringR = Math.max(4, radius - JOIN_MARGIN);
  if (ringCoverage(ink, W, H, point, ringR) < MIN_RING_COVER) {
    const found = circleInInk(ink, W, H, b);
    if (found) return { center: found.center, radius: found.r + JOIN_MARGIN, contour: null as Contour | null };
  }
  return { center: point, radius: Math.max(10, radius), contour: null as Contour | null };
}

function splitSide(mask: Uint8Array, W: number, H: number, fromY: number, keep: (i: number) => boolean, ropeX: number): Side | null {
  const rowW = new Int32Array(H);
  for (let y = fromY; y < H; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < W; x++)
      if (mask[y * W + x] && keep(y * W + x)) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    rowW[y] = x0 < 0 ? 0 : x1 - x0 + 1;
  }
  let maxW = 0;
  for (let y = fromY; y < H; y++) maxW = Math.max(maxW, rowW[y]);
  if (maxW < 6) return null;
  let top = -1;
  for (let y = fromY; y < H; y++)
    if (rowW[y] >= maxW * WEIGHT_ROW_FRACTION) {
      top = y;
      break;
    }
  if (top < 0) return null;
  const weight = new Uint8Array(W * H);
  const rope = new Uint8Array(W * H);
  let pixels = 0;
  for (let y = fromY; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i] || !keep(i)) continue;
      if (y >= top) {
        weight[i] = 1;
        pixels++;
      } else rope[i] = 1;
    }
  const weightBox = maskBounds(weight, W, H);
  if (!weightBox || pixels < 40) return null;
  const ropeBox = maskBounds(rope, W, H);
  return { weight, rope, weightBox, ropeBox: ropeBox && ropeBox.h > 4 ? ropeBox : null, ropeX, pixels };
}

/**
 * Which side of the axle each ink pixel hangs on: 1 = left, 2 = right, 0 = none. Decided per connected
 * stroke by its centre of mass, not per pixel, so a wide weight drawn across the centre line moves as one
 * piece with its own rope instead of being sliced in two.
 */
function sideMap(mask: Uint8Array, W: number, H: number, cx: number): Uint8Array {
  const side = new Uint8Array(W * H);
  const label = new Int32Array(W * H).fill(-1);
  const stack: number[] = [];
  const members: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    members.length = 0;
    let sx = 0;
    label[start] = start;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % W, y = (i - x) / W;
      sx += x;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (mask[j] && label[j] < 0) {
            label[j] = start;
            stack.push(j);
          }
        }
    }
    const s = sx / members.length < cx ? 1 : 2;
    for (const i of members) side[i] = s;
  }
  return side;
}

/** AI mass for the weight under this box, if the AI labelled one. */
function aiMass(input: SceneInput, box: Side['weightBox']): number | null {
  for (const c of input.contours) {
    const r = roleOf(input, c.id);
    if (!r || r.role !== 'mass' || !(r.mass > 0)) continue;
    const { x, y } = c.centroid;
    if (x >= box.x - 8 && x <= box.x + box.w + 8 && y >= box.y - 8 && y <= box.y + box.h + 8) return r.mass;
  }
  return null;
}

export const buildPulley: SceneBuilder = (input) => {
  const { width: W, height: H } = input;

  // Junk from the photo itself: thin strokes hugging the image border (paper edge, table, shadow line).
  // Never part of the machine; erased from the background so it doesn't distract.
  const bx = W * BORDER_FRAC, by = H * BORDER_FRAC;
  const isThin = (c: Contour) => Math.max(c.bbox.w, c.bbox.h) > Math.min(c.bbox.w, c.bbox.h) * THIN_ASPECT;
  const nearBorder = (c: Contour) =>
    c.bbox.x < bx || c.bbox.y < by || c.bbox.x + c.bbox.w > W - bx || c.bbox.y + c.bbox.h > H - by;
  // 'other' carries no information (the offline heuristic labels everything 'other').
  const knownRole = (c: Contour) => {
    const r = roleOf(input, c.id);
    return r && r.role !== 'other' ? r : null;
  };
  const biggest = input.contours.reduce((m, c) => (c.inkPixels > m.inkPixels ? c : m), input.contours[0]);
  const speck = (c: Contour) =>
    c !== biggest && c.inkPixels < biggest.inkPixels * SPECK_FRAC && c.area < biggest.area * SPECK_FRAC;
  const junk = input.contours.filter((c) => !knownRole(c) && isThin(c) && nearBorder(c));

  // Moving candidates: everything except junk and things the AI says are fixed scenery.
  const scenery = (c: Contour) => {
    if (junk.includes(c) || (!knownRole(c) && speck(c))) return true;
    const r = knownRole(c);
    if (r) return r.role === 'ground' || r.role === 'pivot' || r.role === 'incline';
    // No AI role: a flat open stroke is a floor/ceiling bar, not a weight. It stays in the background.
    return !c.hasHole && c.bbox.w > c.bbox.h * THIN_ASPECT;
  };
  let parts = input.contours.filter((c) => !scenery(c));
  if (!parts.length) parts = input.contours;

  const wheel = findWheel(input, parts, contourMask(input, parts));
  const { center: C, radius: R } = wheel;

  // Ropes leave the wheel at C.x ± R and the weights hang from them, so every moving stroke crosses the
  // band around the wheel. Anything entirely outside it (stray marks off to the side) stays put.
  const band = R * 1.6;
  const near = parts.filter((c) => c.bbox.x <= C.x + band && c.bbox.x + c.bbox.w >= C.x - band);
  const all = contourMask(input, near.length ? near : parts);

  // Rope + weight mask: drop the wheel and everything at or above the axle (ceiling, support bar).
  const lower = all.slice();
  if (wheel.contour) {
    const wm = contourMask(input, [wheel.contour]);
    for (let i = 0; i < lower.length; i++) if (wm[i]) lower[i] = 0;
  }
  const clear2 = (R * WHEEL_CLEAR) ** 2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!lower[i]) continue;
      if (y <= C.y || (x - C.x) ** 2 + (y - C.y) ** 2 < clear2) lower[i] = 0;
    }

  const fromY = Math.ceil(C.y);
  const sides = sideMap(lower, W, H, C.x);
  const left = splitSide(lower, W, H, fromY, (i) => sides[i] === 1, C.x - R);
  const right = splitSide(lower, W, H, fromY, (i) => sides[i] === 2, C.x + R);
  // Can't find two weights: the fallback still makes everything fall, so nothing is ever frozen.
  if (!left || !right) return buildFallback(input);

  // Masses: AI value if given, else drawn area (bigger drawing = heavier).
  let mL = aiMass(input, left.weightBox) ?? left.pixels;
  let mR = aiMass(input, right.weightBox) ?? right.pixels;
  if (Math.abs(mL - mR) / Math.max(mL, mR) < TIE_TOLERANCE) {
    // Equal masses would just hang there forever, which reads as "broken" in a live demo.
    // Tip the balance towards the bigger drawing (right on a tie) so it always visibly moves.
    if (left.pixels > right.pixels) mL = mR * TIE_BREAK_RATIO;
    else mR = mL * TIE_BREAK_RATIO;
  }
  if (mL > mR * MAX_MASS_RATIO) mL = mR * MAX_MASS_RATIO;
  if (mR > mL * MAX_MASS_RATIO) mR = mL * MAX_MASS_RATIO;

  // Entered kg replace the drawn ratio: both entered = as entered; one entered = the other keeps the drawn
  // ratio to it; none = the lighter weight is 1 kg. (The motion only depends on the ratio.)
  const noteL = noteFor(input.analysis, 'mass', ['left weight'])?.value;
  const noteR = noteFor(input.analysis, 'mass', ['right weight'])?.value;
  let fromL: ValueSource = 'assumed';
  let fromR: ValueSource = 'assumed';
  if (noteL !== undefined && noteR !== undefined) {
    mL = noteL;
    mR = noteR;
    fromL = fromR = 'input';
    // Exactly equal weights would hang still forever: tip the bigger drawing a little and say so.
    if (Math.abs(mL - mR) / Math.max(mL, mR) < 1e-3) {
      if (left.pixels > right.pixels) {
        mL = mR * TIE_BREAK_RATIO;
        fromL = 'adjusted';
      } else {
        mR = mL * TIE_BREAK_RATIO;
        fromR = 'adjusted';
      }
    }
  } else if (noteL !== undefined) {
    mR = noteL * (mR / mL);
    mL = noteL;
    fromL = 'input';
  } else if (noteR !== undefined) {
    mL = noteR * (mL / mR);
    mR = noteR;
    fromR = 'input';
  }
  const anyNote = noteL !== undefined || noteR !== undefined;
  const kgL = anyNote ? mL : mL / Math.min(mL, mR);
  const kgR = anyNote ? mR : mR / Math.min(mL, mR);

  const makeBody = (s: Side) => {
    const b = s.weightBox;
    return Matter.Bodies.rectangle(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, {
      inertia: Infinity,
      friction: 0,
      frictionAir: 0,
      // Motion is driven by onStep; collisions would only fight the rope constraint.
      collisionFilter: { group: -1, category: 0, mask: 0 },
    });
  };
  const bodyL = makeBody(left);
  const bodyR = makeBody(right);
  const homeL = { ...bodyL.position };
  const homeR = { ...bodyR.position };

  // Travel limit: the rising weight must not enter the wheel, the falling one stops on the bottom edge of
  // the picture (only if that leaves too little room may it sink up to half its height past the edge).
  const travel = (fall: Side, rise: Side) => {
    const roomUp = rise.weightBox.y - (C.y + R + WHEEL_GAP);
    const roomDown = H - (fall.weightBox.y + fall.weightBox.h);
    const t = Math.min(roomUp, roomDown);
    if (t >= MIN_TRAVEL) return t;
    return Math.max(Math.min(roomUp, roomDown + fall.weightBox.h * 0.5), MIN_TRAVEL);
  };
  const maxDown = mL > mR ? travel(left, right) : travel(right, left);

  // Slowdown of this scene's gravity (see TARGET_FALL_S): s = a t² / 2  =>  px/m = 2 * travel / (a * T²), at 9.8 m/s².
  // Only the on-screen speed; the readouts use units.ts (paper = 1 m) with gravityScale = `scale`.
  const aRel = Math.abs(mL - mR) / (mL + mR);
  const pxPerM = Math.min(DEFAULT_PX_PER_M, (2 * maxDown) / (aRel * 9.8 * TARGET_FALL_S ** 2));
  const scale = pxPerM / DEFAULT_PX_PER_M;

  // s = downward displacement of the left weight (right moves up by s). One degree of freedom.
  let s = 0;
  let v = 0;
  let hold = 0;
  const onStep = (engine: Matter.Engine) => {
    if (hold > 0) {
      if (--hold === 0) {
        s = 0;
        v = 0;
      }
    } else {
      // Engine gravity (follows slider / voice / moon mode) in px/step², converted to this drawing's scale.
      const g = engine.gravity.y * engine.gravity.scale * STEP_MS * STEP_MS * scale;
      const a = (g * (mL - mR)) / (mL + mR);
      v += a;
      s += v;
      if (Math.abs(s) >= maxDown) {
        s = Math.sign(s) * maxDown;
        v = 0;
        hold = HOLD_STEPS;
      }
    }
    Matter.Body.setPosition(bodyL, { x: homeL.x, y: homeL.y + s });
    Matter.Body.setPosition(bodyR, { x: homeR.x, y: homeR.y - s });
    Matter.Body.setVelocity(bodyL, { x: 0, y: hold ? 0 : v });
    Matter.Body.setVelocity(bodyR, { x: 0, y: hold ? 0 : -v });
  };

  // Ropes: the hand-drawn rope stretched/shrunk vertically to the new length (top stays on the wheel).
  const ropeSprite = (side: Side) => (side.ropeBox ? cutSprite(input, side.rope) : null);
  const ropeImgL = ropeSprite(left);
  const ropeImgR = ropeSprite(right);

  // Wheel: rotate the drawn wheel with the rope (no slip) when it is its own stroke.
  const wheelMask = wheel.contour ? contourMask(input, [wheel.contour]) : null;
  const wheelImg = wheelMask ? cutSprite(input, wheelMask) : null;

  const drawRope = (ctx: CanvasRenderingContext2D, side: Side, img: ReturnType<typeof ropeSprite>, delta: number) => {
    if (img && side.ropeBox) {
      const h = side.ropeBox.h + delta;
      if (h > 1) ctx.drawImage(img.image, img.offset.x, img.offset.y, img.image.width, h);
      return;
    }
    // No rope ink found: draw a pencil-like line from the wheel to the weight top.
    const top = side.weightBox.y + delta;
    if (top <= C.y) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(40,40,48,0.9)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(side.ropeX, C.y);
    ctx.lineTo(side.ropeX, top);
    ctx.stroke();
    ctx.restore();
  };

  const onDraw = (ctx: CanvasRenderingContext2D) => {
    drawRope(ctx, left, ropeImgL, s);
    drawRope(ctx, right, ropeImgR, -s);
    if (wheelImg) {
      ctx.save();
      ctx.translate(C.x, C.y);
      ctx.rotate(-s / R); // left side going down turns the wheel anticlockwise
      ctx.translate(-C.x, -C.y);
      ctx.drawImage(wheelImg.image, wheelImg.offset.x, wheelImg.offset.y);
      ctx.restore();
    }
  };

  const sprites: Sprite[] = [
    { ...cutSprite(input, left.weight), follow: { kind: 'body', body: bodyL, origin: homeL, originAngle: 0 } },
    { ...cutSprite(input, right.weight), follow: { kind: 'body', body: bodyR, origin: homeR, originAngle: 0 } },
  ];

  const erased = [left.weight, right.weight, left.rope, right.rope];
  if (wheelMask) erased.push(wheelMask);
  if (junk.length) erased.push(contourMask(input, junk));

  const half = (s: Side) => Math.max(s.weightBox.w, s.weightBox.h) / 2;
  return {
    bodies: [bodyL, bodyR],
    constraints: [],
    sprites,
    background: eraseFromPaper(input, erased),
    label: 'Pulley',
    onStep,
    onDraw,
    gravityScale: scale,
    // Fastest at the end of the fall: v² = 2·a·travel with a = g·scale·(m₁ − m₂)/(m₁ + m₂).
    speedHint: Math.sqrt(2 * STEP_ACCEL * ((input.analysis.params.gravity || 9.8) / 9.8) * scale * aRel * maxDown),
    measures: { wheel: 2 * R },
    parts: {
      'left weight': { at: () => bodyL.position, clear: half(left), side: 'left', body: bodyL, kg: kgL, kgFrom: fromL },
      'right weight': { at: () => bodyR.position, clear: half(right), side: 'right', body: bodyR, kg: kgR, kgFrom: fromR },
      wheel: { at: () => C, clear: R, side: 'above' },
    },
  };
};
