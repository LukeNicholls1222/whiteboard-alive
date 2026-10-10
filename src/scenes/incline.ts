// Incline: a drawn triangle becomes a static ramp, the drawn block on it slides down (and may stop by friction).
// Once it has stopped, it waits a moment and slides again from the start.
// An entered angle (Your numbers) stretches the drawn triangle up or down to that slope, base kept as drawn.

import Matter from 'matter-js';
import type { CleanPart, Contour, Point, SceneBuilder, SceneInput, Sprite, ValueSource } from '../types';
import { contourMask, cutSprite, eraseFromPaper, roleOf } from './common';
import { replayWhenStopped } from './replay';
import { PAPER_FILL, STEP_ACCEL } from '../sim';
import { DEFAULT_KG, noteFor } from '../units';

/** Coulomb friction coefficient μ used when the AI gives no `params.friction`. */
export const DEFAULT_FRICTION = 0.3;
/** Minimum visible slide, as a fraction of the ramp's slope length, even when friction would hold the block. */
const MIN_SLIDE_FRACTION = 0.35;
/** Minimum starting speed along the slope, px per step. */
const MIN_START_SPEED = 0.6;
/** How far (px, or fraction of block size) a block may float above / sink into the slope and still be snapped onto it. */
const SNAP_PX = 30;
const SNAP_BLOCK_FRACTION = 0.6;
/** Extra rotational inertia so wobbly hand-drawn boxes slide instead of tumbling. */
const INERTIA_SCALE = 4;

type Tri = [Point, Point, Point];

// ---- Coulomb friction -------------------------------------------------------------------------
// Matter's built-in friction is not Coulomb friction: below ~2.5 px/step it behaves like a drag whose
// terminal speed depends on the slope but hardly on `friction`, so μ = 0.1 and μ = 0.8 look the same
// (measured). For a physics lesson μ must matter, so incline contacts are frictionless in Matter and we
// apply |Δv_t| ≤ μ·g·|ĝ·n| ourselves after every Engine.update. Reads the engine's live gravity, so
// moon mode still works. Only bodies registered here are touched; `plugin.inclineMu` can be changed live.

const frictionBodies = new WeakSet<Matter.Body>();
let frictionHooked = false;

function hookFriction() {
  if (frictionHooked) return;
  frictionHooked = true;
  const update = Matter.Engine.update;
  Matter.Engine.update = function (engine: Matter.Engine, delta?: number, correction?: number) {
    const out = update.call(Matter.Engine, engine, delta, correction);
    applyFriction(engine, delta ?? 1000 / 60);
    return out;
  };
}

function applyFriction(engine: Matter.Engine, delta: number) {
  const gx = engine.gravity.x, gy = engine.gravity.y;
  const gLen = Math.hypot(gx, gy);
  const gStep = engine.gravity.scale * gLen * delta * delta; // px/step² of gravity
  if (gStep <= 0) return;
  const done = new Set<Matter.Body>();
  for (const pair of (engine.pairs?.list ?? []) as Matter.Pair[]) {
    if (!pair.isActive) continue;
    const col = pair.collision;
    for (const [body, other] of [[col.parentA, col.parentB], [col.parentB, col.parentA]] as const) {
      if (!frictionBodies.has(body) || !other.isStatic || done.has(body)) continue;
      done.add(body);
      const n = col.normal;
      const mu = Number((body.plugin as { inclineMu?: number }).inclineMu ?? DEFAULT_FRICTION);
      const maxDrop = mu * gStep * Math.abs((gx * n.x + gy * n.y) / gLen);
      const v = Matter.Body.getVelocity(body);
      const vn = v.x * n.x + v.y * n.y;
      const vt = { x: v.x - vn * n.x, y: v.y - vn * n.y };
      const s = Math.hypot(vt.x, vt.y);
      if (s <= maxDrop) {
        // Static friction holds: undo this step's tangential creep, then stop sliding.
        Matter.Body.translate(body, { x: -vt.x, y: -vt.y });
        Matter.Body.setVelocity(body, { x: v.x - vt.x, y: v.y - vt.y });
      } else {
        const k = maxDrop / s;
        Matter.Body.setVelocity(body, { x: v.x - vt.x * k, y: v.y - vt.y * k });
      }
    }
  }
}

const triArea = (a: Point, b: Point, c: Point) => Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;

function polyArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

/** Largest-area triangle whose corners are hull points (hulls are small; subsample if not). */
function bestTriangle(hull: Point[]): { tri: Tri; area: number } | null {
  if (hull.length < 3) return null;
  let pts = hull;
  if (pts.length > 48) {
    const step = pts.length / 48;
    pts = Array.from({ length: 48 }, (_, i) => hull[Math.floor(i * step)]);
  }
  let best: Tri | null = null, bestA = -1;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      for (let k = j + 1; k < pts.length; k++) {
        const a = triArea(pts[i], pts[j], pts[k]);
        if (a > bestA) {
          bestA = a;
          best = [pts[i], pts[j], pts[k]];
        }
      }
  return best ? { tri: best, area: bestA } : null;
}

/** How triangle-like a hull is: 1 = exact triangle, ~0.5 = rectangle. */
function triangularity(c: Contour): number {
  const t = bestTriangle(c.hull);
  const a = polyArea(c.hull);
  return t && a > 0 ? t.area / a : 0;
}

interface Slope {
  /** Upper (start) and lower (end) end of the sloped edge. */
  top: Point;
  bottom: Point;
  /** Unit vector pointing down the slope. */
  dir: Point;
  /** Unit normal pointing out of the ramp (towards where a block sits). */
  normal: Point;
  /** Angle from horizontal, radians (0..π/2). */
  angle: number;
  length: number;
}

/** The sloped side: the edge that is long and most diagonal (neither the floor nor the vertical wall). */
function slopeOf(tri: Tri): Slope {
  let best = 0, score = -1;
  for (let i = 0; i < 3; i++) {
    const p = tri[i], q = tri[(i + 1) % 3];
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    const s = len * Math.abs(Math.sin(2 * Math.atan2(dy, dx)));
    if (s > score) {
      score = s;
      best = i;
    }
  }
  const p = tri[best], q = tri[(best + 1) % 3], third = tri[(best + 2) % 3];
  const [top, bottom] = p.y <= q.y ? [p, q] : [q, p];
  return slopeFrom(top, bottom, third);
}

/** The slope from its upper and lower end; `third` = the ramp's other corner (the normal points away from it). */
function slopeFrom(top: Point, bottom: Point, third: Point): Slope {
  const length = Math.max(1, Math.hypot(bottom.x - top.x, bottom.y - top.y));
  const dir = { x: (bottom.x - top.x) / length, y: (bottom.y - top.y) / length };
  let normal = { x: -dir.y, y: dir.x };
  // Point the normal away from the ramp's third corner (i.e. towards the open side above the slope).
  if ((third.x - top.x) * normal.x + (third.y - top.y) * normal.y > 0) normal = { x: -normal.x, y: -normal.y };
  const angle = Math.atan2(Math.abs(bottom.y - top.y), Math.abs(bottom.x - top.x));
  return { top, bottom, dir, normal, angle, length };
}

const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });

/** Signed height of the block's lowest hull point above the slope line (negative = sunk in). */
function clearance(hull: Point[], s: Slope): number {
  return Math.min(...hull.map((p) => dot(sub(p, s.top), s.normal)));
}

/** Position along the slope (0 = top end, 1 = bottom end). */
const along = (p: Point, s: Slope) => dot(sub(p, s.top), s.dir) / s.length;

// ---- Geometry helpers ---------------------------------------------------------------------------

/** Convex hull (Andrew's monotone chain). */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [], upper: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Longest distance across a hull. */
function diameter(hull: Point[]): number {
  let d = 0;
  for (let i = 0; i < hull.length; i++)
    for (let j = i + 1; j < hull.length; j++) d = Math.max(d, Math.hypot(hull[i].x - hull[j].x, hull[i].y - hull[j].y));
  return d;
}

/** Hull area / diameter²: ~0.5 for a square, ~0.4 for a disc, < 0.1 for a sliver (paper edge, stray line). */
const compactness = (hull: Point[]) => {
  const d = diameter(hull);
  return d > 0 ? polyArea(hull) / (d * d) : 0;
};

/** Triangle grown outwards so every edge moves by `d` px (scaled about the incentre). */
function growTri(t: Tri, d: number): Tri {
  const [A, B, C] = t;
  const a = Math.hypot(B.x - C.x, B.y - C.y), b = Math.hypot(A.x - C.x, A.y - C.y), c = Math.hypot(A.x - B.x, A.y - B.y);
  const per = a + b + c || 1;
  const I = { x: (a * A.x + b * B.x + c * C.x) / per, y: (a * A.y + b * B.y + c * C.y) / per };
  const rho = Math.max(1, (2 * triArea(A, B, C)) / per);
  const k = (rho + d) / rho;
  return t.map((p) => ({ x: I.x + (p.x - I.x) * k, y: I.y + (p.y - I.y) * k })) as Tri;
}

function inTri(t: Tri, x: number, y: number): boolean {
  const [A, B, C] = t;
  const s1 = (B.x - A.x) * (y - A.y) - (B.y - A.y) * (x - A.x);
  const s2 = (C.x - B.x) * (y - B.y) - (C.y - B.y) * (x - B.x);
  const s3 = (A.x - C.x) * (y - C.y) - (A.y - C.y) * (x - C.x);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

/** Filled polygon mask with a stroke margin. */
function polyMask(W: number, H: number, poly: Point[], margin: number): Uint8Array {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineWidth = margin * 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  if (margin > 0) ctx.stroke();
  const d = ctx.getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 0 ? 1 : 0;
  return m;
}

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Blob {
  count: number;
  hull: Point[];
  centroid: Point;
}

/** Connected components of `on` inside the region; hulls come from each row's leftmost/rightmost pixel. */
function components(on: (i: number) => boolean, W: number, r: Region, eight: boolean): Blob[] {
  const seen = new Uint8Array(W * (r.y1 + 1));
  const out: Blob[] = [];
  const stack: number[] = [];
  const nb = eight ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++) {
      const s = y * W + x;
      if (seen[s] || !on(s)) continue;
      seen[s] = 1;
      stack.push(s);
      let count = 0, sx = 0, sy = 0;
      const rowMin = new Map<number, number>(), rowMax = new Map<number, number>();
      while (stack.length) {
        const i = stack.pop()!;
        const px = i % W, py = (i - px) / W;
        count++;
        sx += px;
        sy += py;
        if (!(rowMin.get(py)! <= px)) rowMin.set(py, px);
        if (!(rowMax.get(py)! >= px)) rowMax.set(py, px);
        for (const [dx, dy] of nb) {
          const nx = px + dx, ny = py + dy;
          if (nx < r.x0 || nx > r.x1 || ny < r.y0 || ny > r.y1) continue;
          const j = ny * W + nx;
          if (!seen[j] && on(j)) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      const pts: Point[] = [];
      for (const [yy, xx] of rowMin) pts.push({ x: xx, y: yy }, { x: rowMax.get(yy)!, y: yy });
      out.push({ count, hull: convexHull(pts), centroid: { x: sx / count, y: sy / count } });
    }
  return out;
}

// ---- Ramp and block detection -------------------------------------------------------------------

/** Holes smaller than this share of the contour's box are not the ramp's inside. */
const MIN_HOLE_SHARE = 0.03;
/** A hole this triangle-like (triangle area / hull area) counts as the ramp's inside. */
const MIN_HOLE_TRIANGULARITY = 0.7;
/** Block candidates: minimum hull area as a share of the ramp, and absolute px². */
const MIN_BLOCK_SHARE = 0.015;
const MIN_BLOCK_PX = 300;
/** Block candidates thinner than this (see compactness) are paper edges / stray strokes. */
const MIN_BLOCK_COMPACTNESS = 0.12;

interface Ramp {
  /** Outer edge of the drawn triangle: the surface blocks rest on. */
  tri: Tri;
  /** Inner edge of the drawn stroke (the triangle's hole), or `tri` when no hole was found. */
  inner: Tri;
  /** Stroke width estimate, px. */
  stroke: number;
}

/** Pen stroke width: median ink run measured outwards from the hole's edges. */
function strokeWidth(ink: Uint8Array, W: number, H: number, tri: Tri): number {
  const runs: number[] = [];
  const [A, B, C] = tri;
  const cx = (A.x + B.x + C.x) / 3, cy = (A.y + B.y + C.y) / 3;
  for (let e = 0; e < 3; e++) {
    const p = tri[e], q = tri[(e + 1) % 3];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    let n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    if ((cx - mx) * n.x + (cy - my) * n.y > 0) n = { x: -n.x, y: -n.y };
    for (let s = 0.15; s <= 0.85; s += 0.05) {
      const bx = p.x + (q.x - p.x) * s, by = p.y + (q.y - p.y) * s;
      let start = -1, end = -1;
      for (let k = -4; k <= 40; k++) {
        const x = Math.round(bx + n.x * k), y = Math.round(by + n.y * k);
        const isInk = x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x] > 0;
        if (isInk && start < 0) start = k;
        if (!isInk && start >= 0) {
          end = k;
          break;
        }
      }
      if (start >= 0 && end > start) runs.push(end - start);
    }
  }
  if (!runs.length) return 6;
  runs.sort((a, b) => a - b);
  return Math.max(2, Math.min(24, runs[runs.length >> 1]));
}

/** Ink of one contour (the stroke pixels inside its outline). */
function contourInk(input: SceneInput, c: Contour): Uint8Array {
  const fill = contourMask(input, [c], 3);
  const out = new Uint8Array(fill.length);
  for (let i = 0; i < out.length; i++) out[i] = fill[i] && input.ink[i] ? 1 : 0;
  return out;
}

function regionOf(c: Contour, W: number, H: number, pad = 6): Region {
  return {
    x0: Math.max(0, Math.floor(c.bbox.x - pad)),
    y0: Math.max(0, Math.floor(c.bbox.y - pad)),
    x1: Math.min(W - 1, Math.ceil(c.bbox.x + c.bbox.w + pad)),
    y1: Math.min(H - 1, Math.ceil(c.bbox.y + c.bbox.h + pad)),
  };
}

/**
 * The ramp triangle. A drawn triangle encloses paper, so its inside is the biggest triangle-shaped hole in
 * the contour's ink — this ignores a box drawn touching the slope and a ground line running past the ramp,
 * which both wreck a hull-based guess. Falls back to the largest triangle on the contour's hull.
 */
function findRamp(input: SceneInput, c: Contour, ink: Uint8Array): Ramp | null {
  const { width: W, height: H } = input;
  const r = regionOf(c, W, H);
  // Paper reachable from the region's border is outside; the rest of the paper is enclosed holes.
  const outside = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * W + x;
    if (!outside[i] && !ink[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = r.x0; x <= r.x1; x++) (push(x, r.y0), push(x, r.y1));
  for (let y = r.y0; y <= r.y1; y++) (push(r.x0, y), push(r.x1, y));
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % W, y = (i - x) / W;
    if (x > r.x0) push(x - 1, y);
    if (x < r.x1) push(x + 1, y);
    if (y > r.y0) push(x, y - 1);
    if (y < r.y1) push(x, y + 1);
  }
  const holes = components((i) => !ink[i] && !outside[i], W, r, false);
  const boxArea = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  let inner: Tri | null = null, score = -1;
  for (const h of holes) {
    if (h.count < boxArea * MIN_HOLE_SHARE || h.hull.length < 3) continue;
    const t = bestTriangle(h.hull);
    const hullA = polyArea(h.hull);
    if (!t || hullA <= 0) continue;
    const tri = t.area / hullA;
    if (tri < MIN_HOLE_TRIANGULARITY) continue;
    const sc = h.count * Math.pow(tri, 4);
    if (sc > score) {
      score = sc;
      inner = t.tri;
    }
  }
  if (inner) {
    const stroke = strokeWidth(ink, W, H, inner);
    return { tri: growTri(inner, stroke), inner, stroke };
  }
  const t = bestTriangle(c.hull);
  return t ? { tri: t.tri, inner: t.tri, stroke: 0 } : null;
}

interface Block {
  /** Physics outline. */
  hull: Point[];
  centroid: Point;
  /** Pixels that move with the block (sprite) and pixels erased from the background. */
  sprite: Uint8Array;
  erase: Uint8Array;
}

function blockFromContour(input: SceneInput, c: Contour): Block {
  const mask = contourMask(input, [c]);
  return { hull: c.hull, centroid: c.centroid, sprite: mask, erase: mask };
}

/** Is this outline big and solid enough to be a block (not a paper-edge sliver or a stray stroke)? */
const blockLike = (hull: Point[], ramp: Ramp) =>
  hull.length >= 3 &&
  polyArea(hull) >= Math.max(MIN_BLOCK_PX, MIN_BLOCK_SHARE * triArea(...ramp.tri)) &&
  compactness(hull) >= MIN_BLOCK_COMPACTNESS;

/**
 * Blocks drawn touching the ramp end up in the ramp's contour. Remove the triangle's stroke from that ink;
 * what is left on the open side of the slope (a box missing its bottom edge) is the block. Its bottom is
 * closed by projecting it onto the slope, so the physics shape sits on the surface and the sprite carries
 * the bit of slope line under the box along with it.
 */
function splitBlocks(input: SceneInput, c: Contour, ink: Uint8Array, ramp: Ramp, slope: Slope): Block[] {
  const { width: W, height: H } = input;
  const pad = Math.max(4, ramp.stroke);
  const cut = growTri(ramp.inner, ramp.stroke + pad);
  const keep = growTri(ramp.inner, ramp.stroke + 2);
  const r = regionOf(c, W, H);
  const rest = components((i) => !!ink[i] && !inTri(cut, i % W, Math.floor(i / W)), W, r, true);
  const out: Block[] = [];
  for (const b of rest) {
    if (!blockLike(b.hull, ramp)) continue;
    if (dot(sub(b.centroid, slope.top), slope.normal) <= 0) continue;
    const t = along(b.centroid, slope);
    if (t < -0.25 || t > 1.25) continue;
    // Hull points near the slope, dropped onto the surface (physics) and onto the stroke's inner edge (sprite).
    const reach = pad + ramp.stroke + 6;
    const near = b.hull.filter((p) => dot(sub(p, slope.top), slope.normal) <= reach);
    const drop = (p: Point, depth: number) => {
      const h = dot(sub(p, slope.top), slope.normal) + depth;
      return { x: p.x - slope.normal.x * h, y: p.y - slope.normal.y * h };
    };
    const hull = convexHull([...b.hull, ...near.map((p) => drop(p, 0))]);
    const spriteHull = convexHull([...b.hull, ...near.map((p) => drop(p, ramp.stroke + 1))]);
    const sprite = polyMask(W, H, spriteHull, 3);
    const erase = new Uint8Array(W * H);
    for (let i = 0; i < erase.length; i++) if (sprite[i] && !inTri(keep, i % W, Math.floor(i / W))) erase[i] = 1;
    const m = hull.reduce((s, p) => ({ x: s.x + p.x / hull.length, y: s.y + p.y / hull.length }), { x: 0, y: 0 });
    out.push({ hull, centroid: m, sprite, erase });
  }
  return out;
}

function pickIncline(input: SceneInput, usable: Contour[]): Contour | null {
  const byRole = usable.filter((c) => roleOf(input, c.id)?.role === 'incline');
  const solid = usable.filter((c) => compactness(c.hull) >= MIN_BLOCK_COMPACTNESS / 2);
  const pool = byRole.length ? byRole : solid.length ? solid : usable;
  let best: Contour | null = null, score = -1;
  for (const c of pool) {
    // Big and triangle-shaped wins; a large rectangle still loses to a smaller clean triangle.
    const t = triangularity(c);
    const sc = polyArea(c.hull) * Math.pow(t, 4);
    if (sc > score) {
      score = sc;
      best = c;
    }
  }
  return best;
}

function pickBlocks(input: SceneInput, usable: Contour[], incline: Contour, ink: Uint8Array, ramp: Ramp, slope: Slope): Block[] {
  const others = usable.filter((c) => c !== incline);
  const byRole = others.filter((c) => {
    const r = roleOf(input, c.id)?.role;
    return r === 'mass' || r === 'projectile';
  });
  const solidByRole = byRole.filter((c) => blockLike(c.hull, ramp));
  if (solidByRole.length) return solidByRole.map((c) => blockFromContour(input, c));
  // No usable roles: the drawing closest to (and above) the slope is the block. Candidates are separate
  // contours and whatever is left of the ramp's own contour once the triangle is taken out.
  const candidates: Block[] = others
    .filter((c) => {
      const r = roleOf(input, c.id);
      return (
        !(r && (r.role === 'ground' || r.role === 'incline' || r.static)) &&
        polyArea(c.hull) < polyArea(incline.hull) &&
        blockLike(c.hull, ramp)
      );
    })
    .map((c) => blockFromContour(input, c));
  candidates.push(...splitBlocks(input, incline, ink, ramp, slope));
  let best: Block | null = null, bestCost = Infinity;
  for (const c of candidates) {
    const h = dot(sub(c.centroid, slope.top), slope.normal);
    const t = along(c.centroid, slope);
    const off = Math.max(0, -t, t - 1) * slope.length;
    const cost = Math.abs(h) + off + (h < 0 ? slope.length : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best ? [best] : [];
}

// ---- Entered angle: stretch the drawing ----------------------------------------------------------

/** Angles an entered value may take (the input box takes the same range). */
const MIN_ANGLE_DEG = 5;
const MAX_ANGLE_DEG = 75;
/** Room kept above a stretched ramp's top corner (clear of the badges over the picture), share of its height. */
const TOP_MARGIN = 0.1;

/**
 * Vertical-only stretch of the ramp: rows above `anchorY` move away from it by ×k, rows below it (the base stroke)
 * stay as drawn, so the base keeps its place and its line width while the high corner rises or sinks. `pad` = blank
 * paper added above the photo when the stretched ramp is taller than the picture: every world y is photo y + pad.
 */
interface Stretch {
  anchorY: number;
  k: number;
  pad: number;
}
const stretchY = (y: number, st: Stretch) => (y < st.anchorY ? st.anchorY - (st.anchorY - y) * st.k : y) + st.pad;
const stretchPt = (p: Point, st: Stretch): Point => ({ x: p.x, y: stretchY(p.y, st) });
const deg = (rad: number) => (rad * 180) / Math.PI;

/**
 * The stretch that makes the slope edge rise at `want` degrees (base length unchanged: height = base × tan θ). Any
 * angle in the input range is taken: when the top corner would leave the picture, blank paper is added above it
 * (`st.pad`) instead of capping the angle. No `want` = as drawn.
 */
function stretchFor(tri: Tri, slope: Slope, stroke: number, H: number, want: number | undefined) {
  const floorY = Math.max(...tri.map((p) => p.y));
  const apexY = Math.min(...tri.map((p) => p.y));
  const anchorY = floorY - Math.max(2, stroke) - 2;
  const { top, bottom } = slope;
  const dx = Math.abs(bottom.x - top.x);
  const angleAt = (k: number) => deg(Math.atan2(Math.abs(stretchY(bottom.y, { anchorY, k, pad: 0 }) - stretchY(top.y, { anchorY, k, pad: 0 })), dx));
  // Rise of the slope edge after the stretch: a + b·k (its lower end may sit in the unstretched base band).
  const a = bottom.y >= anchorY ? bottom.y - anchorY : 0;
  const b = bottom.y >= anchorY ? anchorY - top.y : bottom.y - top.y;
  const canStretch = dx >= 1 && b > 1;
  const maxDeg = MAX_ANGLE_DEG;
  if (want === undefined || !canStretch) return { st: { anchorY, k: 1, pad: 0 }, maxDeg, angle: deg(slope.angle), adjusted: false };
  const target = Math.min(Math.max(want, MIN_ANGLE_DEG), maxDeg);
  const k = Math.max(0.02, (dx * Math.tan((target * Math.PI) / 180) - a) / b);
  // Keep the top corner as far below the top edge as it was drawn (at most TOP_MARGIN of the picture); once paper
  // has to be added, TOP_MARGIN of the taller picture (gap = TOP_MARGIN·(H + pad)), clear of the badges.
  const newApexY = stretchY(apexY, { anchorY, k, pad: 0 });
  const pad =
    newApexY >= Math.min(apexY, TOP_MARGIN * H) ? 0 : Math.max(0, Math.ceil((TOP_MARGIN * H - newApexY) / (1 - TOP_MARGIN)));
  return { st: { anchorY, k, pad }, maxDeg, angle: angleAt(k), adjusted: Math.abs(target - want) > 1e-9 };
}

/**
 * The background with the ramp's hand-drawn lines stretched (`rampMask` = the ramp's ink and inside, without the
 * blocks): erased where they were, redrawn in two slices, the base band as drawn and everything above it ×k. With a
 * `pad` the photo is drawn that far down on a taller canvas, blank paper above it.
 */
function stretchedBackground(input: SceneInput, masks: Uint8Array[], rampMask: Uint8Array, st: Stretch): HTMLCanvasElement {
  const erased = eraseFromPaper(input, [...masks, rampMask]);
  let bg = erased;
  if (st.pad > 0) {
    bg = document.createElement('canvas');
    bg.width = erased.width;
    bg.height = erased.height + st.pad;
    const c = bg.getContext('2d')!;
    c.fillStyle = PAPER_FILL;
    c.fillRect(0, 0, bg.width, bg.height);
    c.drawImage(erased, 0, st.pad);
  }
  const cut = cutSprite(input, rampMask);
  const ctx = bg.getContext('2d')!;
  const { image, offset } = cut;
  const split = Math.min(image.height, Math.max(0, Math.round(st.anchorY - offset.y)));
  const y0 = offset.y + st.pad;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (image.height > split) ctx.drawImage(image, 0, split, image.width, image.height - split, offset.x, y0 + split, image.width, image.height - split);
  if (split > 0) {
    const h = split * st.k;
    ctx.drawImage(image, 0, 0, image.width, split, offset.x, y0 + split - h, image.width, h);
  }
  return bg;
}

/** Is any pixel of `mask` within `r` px of p (outline points sit just outside the ink)? */
function nearMask(mask: Uint8Array, W: number, H: number, p: Point, r = 4): boolean {
  const px = Math.round(p.x), py = Math.round(p.y);
  for (let dy = -r; dy <= r; dy += 2)
    for (let dx = -r; dx <= r; dx += 2) {
      const x = px + dx, y = py + dy;
      if (x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x]) return true;
    }
  return false;
}

const boundsOf = (pts: Point[]) => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

export const buildIncline: SceneBuilder = (input) => {
  const { width: W, height: H } = input;
  const usable = input.contours.filter((c) => c.hull.length >= 3);
  const incline = pickIncline(input, usable);
  if (!incline) throw new Error('incline: no ramp-like contour');
  const ink = contourInk(input, incline);
  const rampShape = findRamp(input, incline, ink);
  if (!rampShape) throw new Error('incline: no ramp-like contour');
  const drawnSlope = slopeOf(rampShape.tri);
  const blocks = pickBlocks(input, usable, incline, ink, rampShape, drawnSlope);
  if (!blocks.length) throw new Error('incline: no block found');

  // An entered angle stretches the ramp vertically (base as drawn); blank paper is added above the photo when the
  // stretched ramp is taller than it (fit.st.pad: the whole world is then that much lower).
  const asked = noteFor(input.analysis, 'angle', ['ramp'])?.value;
  const fit = stretchFor(rampShape.tri, drawnSlope, rampShape.stroke, H, asked);
  const stretched = Math.abs(fit.st.k - 1) > 1e-6;
  const tri = rampShape.tri.map((p) => stretchPt(p, fit.st)) as Tri;
  // slopeOf returns the triangle's own corner objects: the third corner is the one that is neither end.
  const third = rampShape.tri.find((p) => p !== drawnSlope.top && p !== drawnSlope.bottom) ?? rampShape.tri[0];
  const slope = stretched
    ? slopeFrom(stretchPt(drawnSlope.top, fit.st), stretchPt(drawnSlope.bottom, fit.st), stretchPt(third, fit.st))
    : drawnSlope;
  // Drawn blocks are carried over to the new slope: same share of the way along it, same height above it, turned with it.
  const turn = Math.atan2(slope.dir.y, slope.dir.x) - Math.atan2(drawnSlope.dir.y, drawnSlope.dir.x);
  const cosT = Math.cos(turn), sinT = Math.sin(turn);
  const onNewSlope = (p: Point): Point => {
    const u = dot(sub(p, drawnSlope.top), drawnSlope.dir) / drawnSlope.length;
    const h = dot(sub(p, drawnSlope.top), drawnSlope.normal);
    return {
      x: slope.top.x + u * slope.length * slope.dir.x + h * slope.normal.x,
      y: slope.top.y + u * slope.length * slope.dir.y + h * slope.normal.y,
    };
  };

  const mu = Math.max(0, Math.min(1.5, input.analysis.params.friction ?? DEFAULT_FRICTION));
  // Matter's own friction is off on every incline surface; applyFriction() does the real work.
  const surface = { friction: 0, frictionStatic: 0, restitution: 0 };
  hookFriction();

  // Static ramp built from the 3 corners (a triangle's centre of mass is its vertex mean).
  const [a, b, c] = tri;
  const ramp = Matter.Bodies.fromVertices((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, [[a, b, c]], {
    isStatic: true,
    ...surface,
  });
  const rb = ramp.bounds;
  Matter.Body.translate(ramp, {
    x: Math.min(a.x, b.x, c.x) - rb.min.x,
    y: Math.min(a.y, b.y, c.y) - rb.min.y,
  });

  const bodies: Matter.Body[] = [ramp];
  const moving: Matter.Body[] = [];
  const sprites: Sprite[] = [];
  const masks: Uint8Array[] = [];
  /** Each block's cut-out mask (photo px) and its pose when the scene starts, for drawnAt. */
  const starts: { mask: Uint8Array; origin: Point; originAngle: number; at: Point; angle: number }[] = [];

  for (const blk of blocks) {
    const body = Matter.Bodies.fromVertices(blk.centroid.x, blk.centroid.y, [blk.hull], {
      ...surface,
      frictionAir: 0.001,
      plugin: { inclineMu: mu },
    });
    if (!body) continue;
    frictionBodies.add(body);
    const hb = body.bounds;
    const bbox = boundsOf(blk.hull);
    Matter.Body.translate(body, { x: bbox.x - hb.min.x, y: bbox.y - hb.min.y });
    Matter.Body.setInertia(body, body.inertia * INERTIA_SCALE);
    // The cut-out follows the body from here on: moving or turning the body below takes the drawing with it.
    const origin = { ...body.position };
    const originAngle = body.angle;

    // On a stretched ramp the block itself is not stretched: it is put on the new slope, turned to it.
    let hull = blk.hull;
    let centroid = blk.centroid;
    if (stretched) {
      const to = onNewSlope(origin);
      const move = (p: Point): Point => {
        const dx = p.x - origin.x, dy = p.y - origin.y;
        return { x: to.x + dx * cosT - dy * sinT, y: to.y + dx * sinT + dy * cosT };
      };
      hull = hull.map(move);
      centroid = move(centroid);
      Matter.Body.rotate(body, turn);
      Matter.Body.setPosition(body, to);
    }

    // Snap a block that floats a little above / sinks a little into the slope onto it.
    const gap = clearance(hull, slope);
    const size = Math.max(bbox.w, bbox.h);
    const t = along(centroid, slope);
    if (t > -0.1 && t < 1.1 && Math.abs(gap) <= Math.max(SNAP_PX, size * SNAP_BLOCK_FRACTION)) {
      const d = 1 - gap; // leave 1 px of air so it does not start interpenetrating
      Matter.Body.translate(body, { x: slope.normal.x * d, y: slope.normal.y * d });
    }

    // Never a still scene: on a gentle ramp (tanθ ≤ μ) static friction would hold the block from frame 0,
    // which looks like "nothing happened". Instead of faking a lower μ, give the block a starting push down
    // the slope sized so it travels a visible distance and then stops by friction — which is exactly the
    // physics worth showing. On steeper ramps gravity wins anyway and the push is just a nudge.
    const decel = STEP_ACCEL * (mu * Math.cos(slope.angle) - Math.sin(slope.angle));
    const dist = slope.length * MIN_SLIDE_FRACTION;
    const v0 = Math.max(MIN_START_SPEED, decel > 0 ? Math.sqrt(2 * decel * dist) : 0);
    Matter.Body.setVelocity(body, { x: slope.dir.x * v0, y: slope.dir.y * v0 });

    bodies.push(body);
    moving.push(body);
    masks.push(blk.erase);
    starts.push({ mask: blk.sprite, origin, originAngle, at: { ...body.position }, angle: body.angle });
    const cut = cutSprite(input, blk.sprite);
    sprites.push({ image: cut.image, offset: cut.offset, follow: { kind: 'body', body, origin, originAngle } });
  }
  if (bodies.length < 2) throw new Error('incline: block bodies could not be built');
  const block = bodies[1];

  // Floor at the ramp's base and walls at the image edges keep the block on screen (world = photo + blank strip on top).
  const pad = stretched ? fit.st.pad : 0;
  const worldH = H + pad;
  const floorY = Math.min(worldH, Math.max(a.y, b.y, c.y));
  const wallOpts = { isStatic: true, ...surface };
  bodies.push(
    Matter.Bodies.rectangle(W / 2, floorY + 50, W * 3, 100, wallOpts),
    Matter.Bodies.rectangle(-50, worldH / 2, 100, worldH * 4, wallOpts),
    Matter.Bodies.rectangle(W + 50, worldH / 2, 100, worldH * 4, wallOpts),
  );

  const kg = noteFor(input.analysis, 'mass', ['block', 'ball', 'bob'])?.value;
  const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
  // Incentre: the point inside the ramp farthest from all three edges (labels there never touch the slope).
  const la = Math.hypot(b.x - c.x, b.y - c.y), lb = Math.hypot(a.x - c.x, a.y - c.y), lc = Math.hypot(a.x - b.x, a.y - b.y);
  const per = la + lb + lc || 1;
  const inner = { x: (la * a.x + lb * b.x + lc * c.x) / per, y: (la * a.y + lb * b.y + lc * c.y) / per };
  // The ramp stays in the background as drawn (stretched to an entered angle); only the moving blocks are erased.
  let background: HTMLCanvasElement;
  let drawnAt: ((p: Point) => Point) | undefined;
  if (stretched) {
    const rampMask = contourMask(input, [incline], 3);
    for (const m of masks) for (let i = 0; i < rampMask.length; i++) if (m[i]) rampMask[i] = 0;
    background = stretchedBackground(input, masks, rampMask, fit.st);
    // Where drawn ink is shown at the start: blocks moved and turned with their body, the ramp stretched, the rest
    // of the drawing only lowered by the blank strip.
    drawnAt = (p) => {
      for (const s of starts) {
        if (!nearMask(s.mask, W, H, p)) continue;
        const r = s.angle - s.originAngle, cr = Math.cos(r), sr = Math.sin(r);
        const dx = p.x - s.origin.x, dy = p.y - s.origin.y;
        return { x: s.at.x + dx * cr - dy * sr, y: s.at.y + dx * sr + dy * cr };
      }
      return nearMask(rampMask, W, H, p) ? stretchPt(p, fit.st) : { x: p.x, y: p.y + pad };
    };
  } else background = eraseFromPaper(input, masks);
  const angleFrom: ValueSource = asked === undefined ? 'drawn' : fit.adjusted ? 'adjusted' : 'input';
  // Clean figure: the floor line, the ramp as the physics triangle (stretched to an entered angle like the body) and
  // each block as its physics outline.
  const clean: CleanPart[] = [
    { kind: 'ground', y: floorY },
    { kind: 'solid', points: [a, b, c] },
    ...moving.map((body): CleanPart => ({ kind: 'body', body, tone: 'mass' })),
  ];
  return {
    bodies,
    constraints: [],
    sprites,
    clean,
    background,
    label: 'Incline',
    // The picture shows the blank strip too (the photo plus `pad` above it, in this scene's lowered world).
    ...(stretched ? { view: pad > 0 ? { x: 0, y: 0, w: W, h: worldH } : undefined, drawnAt } : {}),
    onStep: replayWhenStopped(moving),
    measures: { ramp: slope.length, ground: x1 - x0 },
    parts: {
      // Inside the triangle: blank paper, and never where the block slides.
      ramp: { at: () => inner, side: 'center' },
      ground: { at: () => ({ x: (x0 + x1) / 2, y: floorY }), side: 'below' },
      block: {
        at: () => block.position,
        clear: Math.max(block.bounds.max.x - block.bounds.min.x, block.bounds.max.y - block.bounds.min.y) / 2,
        side: 'above',
        body: block,
        kg: kg ?? DEFAULT_KG,
        kgFrom: kg ? 'input' : 'assumed',
      },
    },
    physics: {
      rampAngle: deg(drawnSlope.angle),
      rampAngleUsed: { value: deg(slope.angle), from: angleFrom, max: fit.maxDeg },
    },
    // Fastest at the foot of the ramp: v² = v₀² + 2·g(sin θ − μ cos θ)·(slope left below the block) (v₀ = the starting push above).
    speedHint: Math.hypot(Math.max(MIN_START_SPEED, Math.sqrt(2 * Math.max(0, STEP_ACCEL * (mu * Math.cos(slope.angle) - Math.sin(slope.angle))) * slope.length * MIN_SLIDE_FRACTION)), Math.sqrt(2 * Math.max(0, STEP_ACCEL * ((input.analysis.params.gravity || 9.8) / 9.8) * (Math.sin(slope.angle) - mu * Math.cos(slope.angle))) * slope.length * Math.min(1, Math.max(0, 1 - along(block.position, slope))))),
  };
};
