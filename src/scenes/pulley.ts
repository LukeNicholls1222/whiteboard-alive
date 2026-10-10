// Pulley (Atwood machine): a wheel with a rope over it and a weight on each side. The heavier weight falls.
//
// Geometry comes only from the contours and the ink mask:
//   wheel  = AI 'wheel' contour, else the topmost round closed contour, else the thickest blob near the top
//   junk   = thin strokes on the photo border (paper edge, table) and strokes nowhere near the wheel: never move
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
import type { Contour, SceneBuilder, SceneInput, Sprite } from '../types';
import { STEP_MS } from '../sim';
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
 * How long the fall should take at Earth gravity, seconds. A drawing is a picture of a real-size machine,
 * so instead of the default scale (1 m ≈ 102 px, where a 300 px drop at a = g/2 lasts ~1.1 s) we pick the
 * pixels-per-metre for this drawing so the full travel takes this long. The acceleration in m/s² stays
 * exactly a = g(m1 - m2)/(m1 + m2); only the size the drawing represents changes. Lower gravity (moon
 * mode) therefore still slows it down further, as it should.
 */
const TARGET_FALL_S = 3.5;
/** Default Matter scale: px per metre at which 9.8 m/s² is engine gravity 1. Never move faster than that. */
const DEFAULT_PX_PER_M = 1000 / 9.8;
/** Contours closer than this (fraction of the image size) to the photo border are paper edges / table, not ink. */
const BORDER_FRAC = 0.03;
/** A stroke this many times longer than it is thick is a line (bar, edge), not a weight. */
const THIN_ASPECT = 6;

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

function findWheel(input: SceneInput, all: Uint8Array) {
  const { width: W, height: H } = input;
  const byRole = input.contours.filter((c) => roleOf(input, c.id)?.role === 'wheel');
  let separate: Contour | null = null;
  if (byRole.length) {
    const best = byRole.sort((a, b) => b.area - a.area)[0];
    if (isRoundBox(best)) separate = best;
  } else {
    // No AI hint: topmost round closed stroke in the upper half of the drawing.
    const b = maskBounds(all, W, H);
    const limit = b ? b.y + b.h * 0.55 : H / 2;
    const cands = input.contours
      .filter((c) => c.hasHole && isRoundBox(c) && c.centroid.y < limit && c.bbox.w > 12)
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
  const junk = input.contours.filter((c) => !knownRole(c) && isThin(c) && nearBorder(c));

  // Moving candidates: everything except junk and things the AI says are fixed scenery.
  const scenery = (c: Contour) => {
    if (junk.includes(c)) return true;
    const r = knownRole(c);
    if (r) return r.role === 'ground' || r.role === 'pivot' || r.role === 'incline';
    // No AI role: a flat open stroke is a floor/ceiling bar, not a weight. It stays in the background.
    return !c.hasHole && c.bbox.w > c.bbox.h * THIN_ASPECT;
  };
  let parts = input.contours.filter((c) => !scenery(c));
  if (!parts.length) parts = input.contours;

  const wheel = findWheel(input, contourMask(input, parts));
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

  // Scale of this drawing (see TARGET_FALL_S): s = a t² / 2  =>  px/m = 2 * travel / (a * T²), at 9.8 m/s².
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

  return {
    bodies: [bodyL, bodyR],
    constraints: [],
    sprites,
    background: eraseFromPaper(input, erased),
    label: 'Pulley',
    onStep,
    onDraw,
  };
};
