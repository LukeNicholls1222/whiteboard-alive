// Offline diagram guess from shape features only (no AI). Used when Gemini is unavailable (quota, busy, offline),
// so a drawing still becomes the right kind of scene instead of "everything falls".
//
// Hand-drawn diagrams are usually ONE connected stroke group (string + bob, wheel + ropes + weights), so contour
// counts say little. Everything here works on the binary ink mask instead:
//   - closed shapes  = enclosed paper regions (holes), classified by how much of their minimum-area bounding
//                      rectangle they fill: triangle ~0.5, circle ~0.79, box ~1.0
//   - solid blobs    = ink much thicker than the pen stroke (a filled-in bob or ball)
//   - zigzag         = a band where scan lines cross the ink many times at a regular spacing, and the band is
//                      deeper than that spacing (hatching on a ceiling is shallow, a spring is deep)
//   - spoked wheels  = a filled disc with three or more radial lines inside (cannon or cart wheels). Counted as one
//                      round shape, and their spokes are left out of the zigzag search (a row through two spoked
//                      wheels crosses ink as often and as regularly as a spring does); with one in the picture a
//                      spring needs twice the zigzag score
// Notebook rules (five or more long thin parallel lines, each its own contour) are taken out of the ink first.
// Decision order: zigzag -> spring, triangle with a long level plank on its tip -> lever, big triangle -> incline,
// wheel with a weight on each side below -> pulley, round thing hanging under ink with nothing below -> pendulum, two
// balls on one level floor with a level arrow -> collision, any other ball-sized round thing -> projectile (one big
// closed curve, e.g. a cloud, is not a ball: fallback).

import type { Contour, DiagramType } from './types';
import { findLever } from './scenes/lever-plan';

export interface GuessInput {
  width: number;
  height: number;
  /** Binary ink mask, non-zero = ink. */
  ink: Uint8Array;
  contours: Contour[];
}

export interface Guess {
  diagram: DiagramType;
  confidence: number;
  /** Short reason, for the console. */
  why: string;
}

type ShapeKind = 'round' | 'box' | 'triangle' | 'other';

interface Shape {
  kind: ShapeKind;
  solid: boolean;
  cx: number;
  cy: number;
  /** Axis-aligned bounds. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  /** area / min-area bounding rectangle. */
  rectFill: number;
  /** Long side / short side of the min-area rectangle. */
  elong: number;
}

// Tunables (sizes are ratios of the shorter image side unless noted).
const HOLE_MIN = 0.035; // smallest closed shape side
const TRI_MIN_AREA = 0.04; // incline triangle area, fraction of minSide²
const SOLID_DEPTH = 1.7; // solid ink: distance to paper ≥ this × stroke width
const SOLID_MIN = 0.025; // solid blob radius
const ZIG_GAP = 0.09; // max gap between crossings inside one zigzag cluster
const ZIG_MIN_CROSS = 5; // crossings of one scan line through a spring
const ZIG_DEPTH = 0.5; // (band depth / crossing spacing) x alternation for a spring; hatching scores ~0
const ZIG_MOVING = 1; // per scan line of a band, crossings that move sideways to the next line (parallel rules: ~0)
const RULED_MIN = 5; // this many long thin parallel lines = notebook rules
const WHEEL_MIN = 0.03; // spoked wheel radius, at least
const WHEEL_SPOKES = 3; // radial lines crossed by a circle half way out from the hub
const BALL_MAX = 0.4; // largest round shape that counts as a projectile's ball or wheel (its longer side)

export function guessDiagram(input: GuessInput): Guess {
  const { width: W, height: H } = input;
  const minSide = Math.min(W, H);
  const { ink, rules } = withoutRules(input);
  if (!ink.some((v) => v))
    return { diagram: 'fallback', confidence: 0, why: rules ? `only notebook rules (${rules})` : 'no ink' };

  const stroke = strokeWidth(ink, W, H);
  const wheels = spokedWheels(ink, W, H, minSide, stroke);
  const inWheel = (x: number, y: number, pad = 0) => wheels.some((w) => Math.hypot(x - w.cx, y - w.cy) <= w.r + pad);
  const shapes = [
    // Pie slices between the spokes are part of their wheel, not shapes of their own.
    ...holes(ink, W, H, minSide).filter((s) => !inWheel(s.cx, s.cy)),
    ...solids(ink, W, H, minSide, stroke).filter((s) => !inWheel(s.cx, s.cy)),
    ...wheels.map((w): Shape => ({
      kind: 'round', solid: false, cx: w.cx, cy: w.cy, x0: w.cx - w.r, y0: w.cy - w.r, x1: w.cx + w.r, y1: w.cy + w.r,
      area: Math.PI * w.r * w.r, rectFill: Math.PI / 4, elong: 1,
    })),
  ];
  let zigInk = ink;
  if (wheels.length) {
    zigInk = ink.slice();
    for (let i = 0; i < zigInk.length; i++) if (zigInk[i] && inWheel(i % W, Math.floor(i / W), 2 * stroke)) zigInk[i] = 0;
  }
  const zig = zigzag(zigInk, W, H, minSide, stroke);
  const round = shapes.filter((s) => s.kind === 'round');
  const tri = shapes
    .filter((s) => s.kind === 'triangle' && s.area >= TRI_MIN_AREA * minSide * minSide)
    .sort((a, b) => b.area - a.area)[0];
  const desc = `stroke=${stroke.toFixed(1)} zig=${zig.toFixed(2)}${rules ? ` rules=${rules}` : ''}${wheels.length ? ` wheels=${wheels.length}` : ''} shapes=${shapes
    .map((s) => `${s.solid ? 'solid-' : ''}${s.kind}@${Math.round(s.cx)},${Math.round(s.cy)}(${s.rectFill.toFixed(2)})/${Math.round(Math.max(s.x1 - s.x0, s.y1 - s.y0))}`)
    .join(' ')}`;

  // A spoked wheel means a cannon or cart: a wheel cut off or half hidden (not recognised as one) still leaves
  // spoke crossings, so only a clearly deep zigzag counts as a spring there.
  if (zig >= ZIG_DEPTH * (wheels.length ? 2 : 1)) return { diagram: 'spring', confidence: Math.round(Math.min(0.9, 0.5 + zig / 10) * 100) / 100, why: `zigzag; ${desc}` };
  const lever = leverGuess(ink, W, H, desc); if (lever) return lever;
  if (tri) return { diagram: 'incline', confidence: 0.7, why: `triangle; ${desc}` };

  // Pulley: a wheel with closed shapes hanging lower on both its left and right.
  for (const w of round) {
    const r = (w.x1 - w.x0) / 2;
    const below = shapes.filter((s) => s !== w && s.cy > w.y1 && Math.abs(s.cx - w.cx) < 4 * r + 0.1 * minSide);
    if (below.some((s) => s.cx < w.cx - r * 0.3) && below.some((s) => s.cx > w.cx + r * 0.3))
      return { diagram: 'pulley', confidence: 0.7, why: `wheel with two weights; ${desc}` };
  }

  // Pendulum: a closed shape with ink just above it (the string) and nothing underneath it.
  const hanging = shapes.filter((s) => hangs(ink, W, H, s, stroke, minSide));
  const hangingRound = hanging.filter((s) => s.kind === 'round');
  if (hangingRound.length && round.length === hangingRound.length && shapes.length <= 2)
    return { diagram: 'pendulum', confidence: 0.65, why: `hanging bob; ${desc}` };

  const coll = collisionGuess(ink, W, H, shapes, wheels, stroke, minSide);
  if (coll) return { ...coll, why: `${coll.why}; ${desc}` };

  // A ball (or a cannon's wheel) is drawn small; one big closed curve (a cloud, a blob) is just a thing that falls.
  if (round.some((s) => Math.max(s.x1 - s.x0, s.y1 - s.y0) <= BALL_MAX * minSide))
    return { diagram: 'projectile', confidence: 0.5, why: `ball not hanging; ${desc}` };
  if (hanging.length === 1 && shapes.length === 1)
    return { diagram: 'pendulum', confidence: 0.4, why: `hanging weight; ${desc}` };
  return { diagram: 'fallback', confidence: 0.2, why: `nothing matched; ${desc}` };
}

/**
 * Ink without notebook rules. Rules = RULED_MIN or more contours that are each one long, thin, nearly horizontal
 * line (no enclosed paper), all at about the same slant. Each rule's ink is erased (the pieces of ink that lie
 * inside its bounding box). A drawing never has that many separate parallel long lines; a ground line or two stay.
 */
function withoutRules(input: GuessInput): { ink: Uint8Array; rules: number } {
  const { width: W, height: H, contours } = input;
  const minSide = Math.min(W, H);
  const lines = contours.filter((c) => {
    const { w, h } = c.bbox;
    return !c.hasHole && w >= 0.15 * minSide && h <= 0.12 * w + 0.02 * minSide && c.inkPixels <= 4 * w;
  });
  if (lines.length < RULED_MIN) return { ink: input.ink, rules: 0 };
  // Slant of each line: its two farthest outline points.
  const slant = (c: Contour) => {
    let a = c.points[0], b = c.points[0], best = -1;
    for (const p of c.points) for (const q of c.points) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d > best) { best = d; a = p; b = q; }
    }
    return a.x === b.x ? Math.PI / 2 : Math.atan((b.y - a.y) / (b.x - a.x));
  };
  const angles = lines.map(slant).sort((p, q) => p - q);
  const mid = angles[angles.length >> 1];
  const rules = lines.filter((c) => Math.abs(slant(c) - mid) < 0.06);
  if (rules.length < RULED_MIN) return { ink: input.ink, rules: 0 };
  const ink = input.ink.slice();
  const inside = (pix: Int32Array) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of pix) {
      const x = i % W, y = (i - x) / W;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return rules.some((c) => x0 >= c.bbox.x - 2 && y0 >= c.bbox.y - 2 && x1 <= c.bbox.x + c.bbox.w + 2 && y1 <= c.bbox.y + c.bbox.h + 2);
  };
  components(W, H, (i) => !!input.ink[i], (pix) => {
    if (inside(pix)) for (const i of pix) ink[i] = 0;
  });
  return { ink, rules: rules.length };
}

interface Wheel {
  cx: number;
  cy: number;
  r: number;
}

/**
 * Spoked wheels: closed paper pockets are filled in (a wheel's pie slices become part of one solid disc). The
 * deepest points of the filled ink, strongest first, are centre candidates (radius R = their depth). One is a wheel if
 *   - there is a rim: in most directions (80 %; a wheel partly hidden behind its cart still counts), ink lies between 0.85 R and 1.25 R from the centre, and
 *   - circles at 45 % and 70 % of R each cross WHEEL_SPOKES or more separate ink lines (spokes), while not being
 *     mostly ink (a coloured-in ball is one solid run).
 * A plain drawn circle (ball, bob, pulley wheel) has no ink inside and is not counted here.
 */
function spokedWheels(ink: Uint8Array, W: number, H: number, minSide: number, stroke: number): Wheel[] {
  const pocket = (0.25 * minSide) ** 2;
  const filled = ink.slice();
  components(W, H, (i) => !ink[i], (pix, n, border) => {
    if (border || n > pocket) return;
    for (const i of pix) filled[i] = 255;
  });
  const d = distance(filled, W, H);
  const rMin = Math.max(4 * stroke, WHEEL_MIN * minSide);
  const out: Wheel[] = [];
  const inkAt = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < W && yi < H && !!ink[yi * W + xi];
  };
  const cand: number[] = [];
  for (let i = 0; i < d.length; i++) if (d[i] >= rMin) cand.push(i);
  cand.sort((p, q) => d[q] - d[p]);
  const taken: { x: number; y: number; r: number }[] = [];
  for (const c of cand) {
    if (taken.length >= 12) break;
    const cx = c % W, cy = (c - cx) / W, R = d[c];
    if (taken.some((t) => Math.hypot(cx - t.x, cy - t.y) < t.r + 0.5 * R)) continue; // overlaps a stronger one
    taken.push({ x: cx, y: cy, r: R });
    // Rim.
    let rim = 0;
    for (let a = 0; a < 360; a += 5) {
      const dx = Math.cos((a * Math.PI) / 180), dy = Math.sin((a * Math.PI) / 180);
      for (let t = 0.85 * R; t <= 1.25 * R; t += 1) if (inkAt(cx + dx * t, cy + dy * t)) { rim++; break; }
    }
    if (rim < 0.8 * 72) continue;
    // Spokes: separate ink runs around circles inside the rim.
    const spoked = [0.45, 0.7].every((k) => {
      const rho = k * R;
      if (rho < 1.5 * stroke) return false;
      const on: boolean[] = [];
      for (let a = 0; a < 360; a++) on.push(inkAt(cx + Math.cos((a * Math.PI) / 180) * rho, cy + Math.sin((a * Math.PI) / 180) * rho));
      const share = on.filter(Boolean).length / on.length;
      let runs = 0;
      for (let a = 0; a < 360; a++) if (on[a] && !on[(a + 359) % 360]) runs++;
      return share <= 0.6 && runs >= WHEEL_SPOKES;
    });
    if (spoked) out.push({ cx, cy, r: R });
  }
  return out;
}

/** Typical pen width: median over ink pixels of min(horizontal run, vertical run) through the pixel. */
function strokeWidth(ink: Uint8Array, W: number, H: number): number {
  const hRun = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!ink[y * W + x]) { x++; continue; }
      let e = x;
      while (e < W && ink[y * W + e]) e++;
      for (let k = x; k < e; k++) hRun[y * W + k] = e - x;
      x = e;
    }
  }
  const hist = new Uint32Array(64);
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!ink[y * W + x]) { y++; continue; }
      let e = y;
      while (e < H && ink[e * W + x]) e++;
      for (let k = y; k < e; k++) hist[Math.min(63, Math.min(e - y, hRun[k * W + x]))]++;
      y = e;
    }
  }
  let total = 0;
  for (const v of hist) total += v;
  let acc = 0;
  for (let i = 0; i < 64; i++) if ((acc += hist[i]) >= total / 2) return Math.max(2, i);
  return 4;
}

/** 4-connected labelling of pixels where `on(i)` is true. Calls `visit` with each component's pixel list. */
function components(W: number, H: number, on: (i: number) => boolean, visit: (pix: Int32Array, n: number, touchesBorder: boolean) => void) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !on(s)) continue;
    let n = 0, top = 0, border = false;
    stack[top++] = s;
    seen[s] = 1;
    const pix: number[] = [];
    while (top) {
      const i = stack[--top];
      pix.push(i);
      n++;
      const x = i % W, y = (i - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      if (x > 0 && !seen[i - 1] && on(i - 1)) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && on(i + 1)) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !seen[i - W] && on(i - W)) { seen[i - W] = 1; stack[top++] = i - W; }
      if (y < H - 1 && !seen[i + W] && on(i + W)) { seen[i + W] = 1; stack[top++] = i + W; }
    }
    visit(Int32Array.from(pix), n, border);
  }
}

/** Describe a pixel set: bounds, centre, and fill of its minimum-area (rotated) bounding rectangle. */
function describe(pix: Int32Array, W: number, solid: boolean): Shape {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sx = 0, sy = 0;
  for (const i of pix) {
    const x = i % W, y = (i - x) / W;
    sx += x;
    sy += y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const n = pix.length;
  const stride = Math.max(1, Math.floor(n / 4000));
  let bestArea = Infinity, bestElong = 1;
  for (let a = 0; a < 180; a += 2) {
    const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < n; k += stride) {
      const i = pix[k], x = i % W, y = (i - x) / W;
      const u = x * c + y * s, v = -x * s + y * c;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const du = u1 - u0 + 1, dv = v1 - v0 + 1;
    if (du * dv < bestArea) {
      bestArea = du * dv;
      bestElong = Math.max(du, dv) / Math.min(du, dv);
    }
  }
  const rectFill = Math.min(1, n / bestArea);
  let kind: ShapeKind = 'other';
  if (rectFill < 0.64 && bestElong < 6) kind = 'triangle';
  else if (rectFill >= 0.68 && rectFill < 0.86 && bestElong < 1.7) kind = 'round';
  else if (rectFill >= 0.84) kind = 'box';
  return { kind, solid, cx: sx / n, cy: sy / n, x0, y0, x1, y1, area: n, rectFill, elong: bestElong };
}

/** Enclosed paper regions (drawn circles, boxes, triangles). */
function holes(ink: Uint8Array, W: number, H: number, minSide: number): Shape[] {
  const out: Shape[] = [];
  const minA = (HOLE_MIN * minSide) ** 2;
  components(W, H, (i) => !ink[i], (pix, n, border) => {
    if (border || n < minA || n > W * H * 0.5) return;
    out.push(describe(pix, W, false));
  });
  return out;
}

/**
 * Filled-in blobs: ink far thicker than the pen (a coloured-in bob or ball). A marker-filled ball photographed
 * under a lamp keeps a few glare specks of paper inside it (black-ink-only detection leaves them out of the ink),
 * which would cut its depth to a fraction of its radius. Enclosed paper specks too small to be a closed shape
 * (under HOLE_MIN) are therefore counted as ink here.
 */
function solids(ink: Uint8Array, W: number, H: number, minSide: number, stroke: number): Shape[] {
  const speck = (HOLE_MIN * minSide) ** 2;
  const filled = ink.slice();
  components(W, H, (i) => !ink[i], (pix, n, border) => {
    if (border || n >= speck) return;
    for (const i of pix) filled[i] = 255;
  });
  const d = distance(filled, W, H);
  const deep = Math.max(SOLID_DEPTH * stroke, SOLID_MIN * minSide * 0.5);
  // Deepest point of each thick core = centre of an inscribed disc. A scribbled-in blob can give several cores;
  // overlapping discs are merged into one.
  const discs: { x0: number; y0: number; x1: number; y1: number; r: number }[] = [];
  components(W, H, (i) => d[i] >= deep, (pix) => {
    let best = 0;
    for (const i of pix) if (d[i] > best) best = d[i];
    if (best < SOLID_MIN * minSide) return;
    // Grow the core back out by its depth to recover the blob's real extent.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of pix) {
      const x = i % W, y = (i - x) / W;
      x0 = Math.min(x0, x - d[i]);
      x1 = Math.max(x1, x + d[i]);
      y0 = Math.min(y0, y - d[i]);
      y1 = Math.max(y1, y + d[i]);
    }
    discs.push({ x0, y0, x1, y1, r: best });
  });
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < discs.length && !merged; i++)
      for (let j = i + 1; j < discs.length && !merged; j++) {
        const a = discs[i], b = discs[j];
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
          discs[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), r: Math.max(a.r, b.r) };
          discs.splice(j, 1);
          merged = true;
        }
      }
  }
  const out: Shape[] = [];
  for (const b of discs) {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    const elong = Math.max(w, h) / Math.max(1, Math.min(w, h));
    // A thick bar (filled cannon barrel, heavy ground line) is not a ball.
    if (elong > 1.8) continue;
    out.push({
      kind: 'round', solid: true, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2,
      x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, area: (Math.PI * w * h) / 4, rectFill: Math.PI / 4, elong,
    });
  }
  return out;
}

/** Two-pass chamfer distance from each ink pixel to the nearest paper pixel. */
function distance(ink: Uint8Array, W: number, H: number): Float32Array {
  const d = new Float32Array(W * H);
  const INF = 1e9, a = 1, b = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = ink[i] ? INF : 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      v = Math.min(v, x > 0 ? d[i - 1] + a : 1);
      if (y > 0) {
        v = Math.min(v, d[i - W] + a);
        if (x > 0) v = Math.min(v, d[i - W - 1] + b);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + b);
      } else v = Math.min(v, 1);
      d[i] = v;
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      v = Math.min(v, x < W - 1 ? d[i + 1] + a : 1);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + a);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + b);
        if (x > 0) v = Math.min(v, d[i + W - 1] + b);
      } else v = Math.min(v, 1);
      d[i] = v;
    }
  return d;
}

type Cluster = { seg: number[]; med: number; alt: number; pairs: number };

/**
 * Spring score. Scan every row and column; on each scan line find a cluster of ≥ZIG_MIN_CROSS ink crossings at a
 * regular spacing. Stack the clusters of neighbouring scan lines into bands. A spring band is
 *   - deep: it lasts over more scan lines than its crossing spacing (the zigzag's amplitude), and
 *   - alternating: from one scan line to the next, neighbouring crossings move in OPPOSITE directions
 *     (the two legs of each tooth). Hatching on a ceiling or wall is all one slant and moves one way.
 * Returns (depth / spacing) × alternation of the best band, 0 if none.
 */
function zigzag(ink: Uint8Array, W: number, H: number, minSide: number, stroke: number): number {
  const gapMax = ZIG_GAP * minSide;
  const step = Math.max(2, Math.round(stroke / 2));
  let best = 0;
  for (const horizontal of [true, false]) {
    const lines = horizontal ? H : W;
    const len = horizontal ? W : H;
    const at = (line: number, k: number) => (horizontal ? ink[line * W + k] : ink[k * W + line]);
    // Crossing centres per scan line; NaN marks a run much longer than the pen (a line along the scan).
    const centres: number[][] = [];
    for (let line = 0; line < lines; line++) {
      const cs: number[] = [];
      let k = 0;
      while (k < len) {
        if (!at(line, k)) { k++; continue; }
        let e = k;
        while (e < len && at(line, e)) e++;
        cs.push(e - k <= 4 * stroke ? (k + e) / 2 : NaN);
        k = e;
      }
      centres.push(cs);
    }
    // Best regular cluster per scan line, with alternation counts against the scan line `step` further on.
    const clusters: (Cluster | null)[] = [];
    for (let line = 0; line < lines; line++) {
      let found: Cluster | null = null;
      let seg: number[] = [];
      const flush = () => {
        const count = seg.length;
        if (count >= ZIG_MIN_CROSS && (!found || count > found.seg.length)) {
          const gaps: number[] = [];
          for (let j = 1; j < count; j++) gaps.push(seg[j] - seg[j - 1]);
          gaps.sort((p, q) => p - q);
          const med = gaps[gaps.length >> 1];
          // Regular: no gap more than 3x the median (text and random clutter are irregular).
          if (gaps[gaps.length - 1] <= 3 * med && med >= stroke) found = { seg, med, alt: 0, pairs: 0 };
        }
        seg = [];
      };
      for (const c of centres[line]) {
        if (isNaN(c)) { flush(); continue; }
        if (seg.length && c - seg[seg.length - 1] > gapMax) flush();
        seg.push(c);
      }
      flush();
      const f = found as Cluster | null;
      if (f && line + step < lines) {
        const next = centres[line + step].filter((v) => !isNaN(v));
        let prevSign = 0;
        for (const p of f.seg) {
          let q = NaN, dq = Infinity;
          for (const v of next) if (Math.abs(v - p) < dq) { dq = Math.abs(v - p); q = v; }
          const dx = dq < f.med * 0.45 ? q - p : 0;
          const sign = Math.abs(dx) >= 0.75 ? Math.sign(dx) : 0;
          if (sign && prevSign) {
            f.pairs++;
            if (sign !== prevSign) f.alt++;
          }
          if (sign) prevSign = sign;
        }
      }
      clusters.push(f);
    }
    // Stack overlapping clusters of consecutive scan lines (tolerating 2-line gaps) into bands.
    let start = -1, last = -1, spacings: number[] = [], alt = 0, pairs = 0;
    let prev: Cluster | null = null;
    const close = () => {
      // Most crossings of a spring shift sideways from one scan line to the next; rules and other parallel
      // lines barely move, so the alternation of their few moving crossings means nothing.
      if (start >= 0 && spacings.length >= 3 && pairs >= 6 && pairs >= ZIG_MOVING * (last - start + 1)) {
        spacings.sort((p, q) => p - q);
        const depth = (last - start + 1) / spacings[spacings.length >> 1];
        best = Math.max(best, depth * (alt / pairs));
      }
      start = -1;
      spacings = [];
      alt = pairs = 0;
      prev = null;
    };
    for (let line = 0; line < lines; line++) {
      const c = clusters[line];
      if (!c) {
        if (start >= 0 && line - last > 2) close();
        continue;
      }
      const p = prev as Cluster | null;
      const overlaps = !!p && c.seg[0] < p.seg[p.seg.length - 1] && c.seg[c.seg.length - 1] > p.seg[0];
      if (start >= 0 && !overlaps) close();
      if (start < 0) start = line;
      spacings.push(c.med);
      alt += c.alt;
      pairs += c.pairs;
      prev = c;
      last = line;
    }
    close();
  }
  return best;
}

/** True if there is ink touching the shape from above (a string) and no ink below it in its column. */
function hangs(ink: Uint8Array, W: number, H: number, s: Shape, stroke: number, minSide: number): boolean {
  const pad = Math.max(3 * stroke, 0.03 * minSide);
  const bx0 = Math.max(0, Math.floor(s.x0)), bx1 = Math.min(W - 1, Math.ceil(s.x1));
  // Ink above: a band just over the shape's top edge (beyond the outline itself).
  let above = 0;
  const ya0 = Math.max(0, Math.floor(s.y0 - stroke - pad * 2)), ya1 = Math.max(0, Math.floor(s.y0 - stroke * 2));
  for (let y = ya0; y <= ya1; y++) for (let x = bx0; x <= bx1; x++) if (ink[y * W + x]) above++;
  if (above < stroke) return false;
  // Ink below or beside the lower half: a ground line, a table, a cliff top. Ignore the shape's own outline
  // (everything within ~2 strokes of its ellipse).
  const w = s.x1 - s.x0, h = s.y1 - s.y0;
  const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
  const rx = w / 2 + stroke * 2.5, ry = h / 2 + stroke * 2.5;
  const lx0 = Math.max(0, Math.floor(s.x0 - 0.6 * w)), lx1 = Math.min(W - 1, Math.ceil(s.x1 + 0.6 * w));
  let below = 0;
  for (let y = Math.max(0, Math.floor(cy + 0.35 * h)); y < H; y++)
    for (let x = lx0; x <= lx1; x++) {
      if (!ink[y * W + x]) continue;
      const ex = (x - cx) / rx, ey = (y - cy) / ry;
      if (ex * ex + ey * ey > 1) below++;
    }
  return below < stroke * 3;
}

// ---- Ball collision ------------------------------------------------------------------------------------

/** Floor and arrows of a collision drawing: within this many degrees of level. */
const COLL_FLOOR_DEG = 15;
const COLL_ARROW_DEG = 20;
/** Share of the columns between and just beside the two balls where the floor line is found. */
const COLL_FLOOR_COVER = 0.7;

/**
 * Two balls (round closed shapes, not spoked wheels) side by side on one level floor line, with at least one level
 * arrow next to (or above) one of them = two balls about to collide. A projectile's launch arrow is slanted, a cannon
 * has a spoked wheel, and two balls without a floor line under both of them are left to the other rules. Null if not.
 */
function collisionGuess(ink: Uint8Array, W: number, H: number, shapes: Shape[], wheels: Wheel[], stroke: number, minSide: number): Guess | null {
  const balls = shapes.filter((s) => {
    const size = Math.max(s.x1 - s.x0, s.y1 - s.y0);
    return s.kind === 'round' && size <= BALL_MAX * minSide && size >= 0.04 * minSide && !wheels.some((w) => Math.hypot(s.cx - w.cx, s.cy - w.cy) < w.r);
  });
  if (balls.length < 2) return null;
  const inkAt = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && !!ink[y * W + x];
  const tan = Math.tan((COLL_FLOOR_DEG * Math.PI) / 180);
  /** The floor line under a pair: y = y0 + k (x − x0) through the outer bottoms of the two rings. */
  let best: { a: Shape; b: Shape; k: number; y0: number; x0: number; cover: number } | null = null;
  for (const a of balls)
    for (const b of balls) {
      if (a === b || a.cx >= b.cx || b.x0 < a.x1 + stroke) continue;
      const k = (b.y1 - a.y1) / (b.cx - a.cx);
      if (Math.abs(k) > tan) continue;
      const rA = (a.x1 - a.x0) / 2, rB = (b.x1 - b.x0) / 2;
      const yAt = (x: number) => a.y1 + stroke + k * (x - a.cx);
      const band = 2.5 * stroke + 0.03 * minSide;
      let n = 0, hit = 0;
      const cols = (from: number, to: number) => {
        for (let x = Math.max(0, Math.round(from)); x <= Math.min(W - 1, Math.round(to)); x += 2) {
          n++;
          const y0 = Math.round(yAt(x) - stroke), y1 = Math.round(yAt(x) + band);
          for (let y = y0; y <= y1; y++) if (inkAt(x, y)) { hit++; break; }
        }
      };
      cols(a.x0 - 0.8 * rA, a.x0 - stroke);
      cols(a.x1 + stroke, b.x0 - stroke);
      cols(b.x1 + stroke, b.x1 + 0.8 * rB);
      const cover = n ? hit / n : 0;
      if (cover >= COLL_FLOOR_COVER && (!best || cover > best.cover)) best = { a, b, k, y0: a.y1 + stroke, x0: a.cx, cover };
    }
  if (!best) return null;
  const { a, b, k } = best;
  const floorY = (x: number) => best!.y0 + k * (x - best!.x0);
  const pair = [a, b];
  const rOf = (s: Shape) => Math.max(s.x1 - s.x0, s.y1 - s.y0) / 2;
  // Arrows: what is left once the two balls and the floor line are taken out.
  const floorBand = 2.5 * stroke + 0.03 * minSide;
  const off = (i: number) => {
    const x = i % W, y = (i - x) / W;
    if (Math.abs(y - floorY(x)) <= floorBand) return true;
    return pair.some((s) => Math.hypot(x - s.cx, y - s.cy) <= rOf(s) + 2 * stroke);
  };
  const arrows: string[] = [];
  components(W, H, (i) => !!ink[i] && !off(i), (pix) => {
    if (pix.length < 10 * stroke) return;
    let sx = 0, sy = 0;
    for (const i of pix) { sx += i % W; sy += Math.floor(i / W); }
    const mx = sx / pix.length, my = sy / pix.length;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const i of pix) {
      const dx = (i % W) - mx, dy = Math.floor(i / W) - my;
      cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const tr = cxx + cyy, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (cxx * cyy - cxy * cxy)));
    const elong = Math.sqrt((tr / 2 + disc) / Math.max(1e-9, tr / 2 - disc));
    let t0 = Infinity, t1 = -Infinity;
    for (const i of pix) {
      const t = ((i % W) - mx) * Math.cos(th) + (Math.floor(i / W) - my) * Math.sin(th);
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
    const len = t1 - t0;
    const deg = Math.abs((th * 180) / Math.PI);
    if (elong < 3 || Math.min(deg, 180 - deg) > COLL_ARROW_DEG || len > 0.45 * W) return;
    // Beside or above one of the balls, above the floor.
    const near = pair.find((s) => {
      const r = rOf(s);
      const x0 = mx - len / 2, x1 = mx + len / 2;
      return len >= Math.max(0.5 * r, 6 * stroke) && x1 >= s.x0 - 2 * r && x0 <= s.x1 + 2 * r && my >= s.cy - 3.5 * r && my <= s.cy + 0.6 * r && my < floorY(mx) - stroke;
    });
    if (near) arrows.push(`${Math.round(mx)},${Math.round(my)}/${Math.round(len)}`);
  });
  if (!arrows.length) return null;
  return {
    diagram: 'collision',
    confidence: 0.6,
    why: `two balls on a level floor (${Math.round((Math.atan(k) * 180) / Math.PI)}°, ${Math.round(best.cover * 100)}%) with level arrows ${arrows.join(' ')}`,
  };
}

/**
 * Seesaw / lever: a triangle with a long, nearly level plank lying on its tip, running both ways (scenes/lever-plan.ts).
 * A ramp's triangle has its slope (and the block on it) running one way from its top corner only, so it stays an incline.
 */
function leverGuess(ink: Uint8Array, W: number, H: number, desc: string): Guess | null {
  const f = findLever(ink, W, H, true);
  return f ? { diagram: 'lever', confidence: 0.7, why: `plank on a triangle (${f.why}); ${desc}` } : null;
}
