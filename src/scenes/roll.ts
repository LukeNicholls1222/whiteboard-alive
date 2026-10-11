// A ball on the incline (pure: no DOM, no Matter; node-testable). incline.ts uses it when the thing drawn on the slope
// is round instead of a box.
//
// Is it round? The outer outline (convex hull of the ink) is walked at even steps and a circle is fitted to those
// points (least squares), then fitted again on the 75 % that sit closest to it: a ball drawn touching the slope loses
// its bottom to the slope's stroke (a straight chord in its outline), and that chord must not spoil the fit. Round =
// what is left is within ROUND_MAX_RESIDUAL of the circle (RMS, share of the radius). A box stays far above it: its
// edge runs from r·cos45° to r, about 0.07-0.1 even after the trim.
//
// How it moves: a solid ball (I = 2/5 m r²) rolls without slipping, a = g sinθ / (1 + I/(m r²)) = 5/7 g sinθ, and
// turns by (distance rolled) / r. When friction cannot hold the contact point (tanθ > 7/2 μ) it slides while it turns:
// a = g (sinθ − μ cosθ), the spin grows from the friction torque. Everything is integrated here in 1-D along the path
// (down the slope, then along the floor), per physics step, not by Matter's contacts: Matter's friction is not Coulomb
// friction (see incline.ts) and a Matter circle would bounce at the foot of the ramp.
// At the foot the ball meets the floor: the part of its speed into the floor is lost and the contact grips at once, so
// the angular momentum about the new contact point is kept: v' = (v cosθ + k·rω) / (1 + k). It then rolls on with a
// very small rolling resistance until it reaches the edge of the picture, where it stops.

import type { Point } from '../types';

/** I / (m r²) of a solid ball. */
export const SOLID_BALL_K = 2 / 5;
/** Round: the outline is this close to a circle (RMS distance from it, share of the radius, after the trim). */
export const ROUND_MAX_RESIDUAL = 0.045;
/** Rolling resistance on the floor: deceleration = this × g (a hard ball on a hard floor). */
export const ROLLING_RESISTANCE = 0.004;
/** Share of the outline points kept for the second circle fit. */
const KEEP = 0.75;
/** Rounds of fit-and-trim. */
const TRIM_ROUNDS = 4;
/** Points walked along the outline. */
const SAMPLES = 120;

export interface Circle {
  c: Point;
  r: number;
}

/** Least-squares circle (Kåsa): minimises Σ (x² + y² + D x + E y + F)². Null for fewer than 3 points or a line. */
export function fitCircle(pts: Point[]): Circle | null {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of pts) (mx += p.x / n), (my += p.y / n);
  // Centred coordinates keep the sums small.
  let sxx = 0, syy = 0, sxy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const p of pts) {
    const x = p.x - mx, y = p.y - my, z = x * x + y * y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  // [sxx sxy sx; sxy syy sy; sx sy n] [D E F]ᵀ = −[sxz syz sz]ᵀ
  const A = [
    [sxx, sxy, sx, -sxz],
    [sxy, syy, sy, -syz],
    [sx, sy, n, -sz],
  ];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
    if (Math.abs(A[piv][i]) < 1e-12) return null;
    [A[i], A[piv]] = [A[piv], A[i]];
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      const f = A[j][i] / A[i][i];
      for (let k = i; k < 4; k++) A[j][k] -= f * A[i][k];
    }
  }
  const D = A[0][3] / A[0][0], E = A[1][3] / A[1][1], F = A[2][3] / A[2][2];
  const r2 = (D * D + E * E) / 4 - F;
  if (!(r2 > 0)) return null;
  return { c: { x: mx - D / 2, y: my - E / 2 }, r: Math.sqrt(r2) };
}

/** Convex hull (Andrew's monotone chain). */
function hullOf(points: Point[]): Point[] {
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

/** `n` points evenly spaced along a closed polygon. */
function walk(poly: Point[], n: number): Point[] {
  const len: number[] = [];
  let total = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    len.push(l);
    total += l;
  }
  if (!(total > 0)) return [];
  const out: Point[] = [];
  let edge = 0, into = 0;
  for (let k = 0; k < n; k++) {
    let d = (k / n) * total - into;
    while (edge < poly.length - 1 && d > len[edge]) {
      d -= len[edge];
      into += len[edge];
      edge++;
    }
    const a = poly[edge], b = poly[(edge + 1) % poly.length];
    const t = len[edge] > 0 ? Math.min(1, d / len[edge]) : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

export interface Roundness {
  /** The circle the outline follows (outer edge of the ink). */
  circle: Circle;
  /** RMS distance of the kept outline points from it, share of its radius. */
  residual: number;
  round: boolean;
}

/** How round the outline of a drawn shape is (see the top of this file). Null when no circle fits at all. */
export function roundness(outline: Point[]): Roundness | null {
  const hull = hullOf(outline);
  if (hull.length < 3) return null;
  const pts = walk(hull, SAMPLES);
  const first = fitCircle(pts);
  if (!first) return null;
  const dist = (c: Circle, p: Point) => Math.abs(Math.hypot(p.x - c.c.x, p.y - c.c.y) - c.r);
  // Fit, keep the points closest to the circle, fit again: a few rounds let a cut-off chord fall out completely.
  let circle = first;
  let kept = pts;
  for (let round = 0; round < TRIM_ROUNDS; round++) {
    const c = circle;
    kept = [...pts].sort((p, q) => dist(c, p) - dist(c, q)).slice(0, Math.max(3, Math.round(KEEP * pts.length)));
    circle = fitCircle(kept) ?? circle;
  }
  const rms = Math.sqrt(kept.reduce((s, p) => s + dist(circle, p) ** 2, 0) / kept.length);
  const residual = rms / circle.r;
  return { circle, residual, round: residual <= ROUND_MAX_RESIDUAL };
}

// ---- Rolling ------------------------------------------------------------------------------------------

/** Acceleration down a slope of angle θ (radians) under gravity g, and whether the ball rolls (true) or slips. */
export function rollAccel(g: number, theta: number, mu: number, k = SOLID_BALL_K): { a: number; rolls: boolean } {
  const rolls = Math.tan(theta) <= (mu * (1 + k)) / k;
  return { a: rolls ? (g * Math.sin(theta)) / (1 + k) : g * (Math.sin(theta) - mu * Math.cos(theta)), rolls };
}

/** Where the ball's centre can go: down the slope from `top`, then along the floor to a stop. World px. */
export interface RollPath {
  /** Ball centre where it starts (on the slope's centre line, r above the surface). */
  top: Point;
  /** Unit vector down the slope. */
  dir: Point;
  /** Unit normal out of the ramp. */
  normal: Point;
  /** Centre-line distance from `top` to the foot (where the centre turns onto the floor). 0 = starts on the floor. */
  slopeLen: number;
  /** Direction along the floor: +1 = right, -1 = left (the way the slope goes down). */
  floorDir: 1 | -1;
  /** Centre-line distance from the foot to where it stops (the edge of the picture). */
  floorLen: number;
  r: number;
  k: number;
}

/**
 * The path of a ball of radius `r` whose centre was drawn at `start`, on a slope from `top` (upper end of the
 * surface) along `dir` (unit, down) with outward `normal`, onto a floor at `floorY`, in a picture `width` wide.
 */
export function rollPath(o: { top: Point; dir: Point; normal: Point; floorY: number; start: Point; r: number; width: number; k?: number }): RollPath {
  const { dir, normal, r } = o;
  const line = { x: o.top.x + normal.x * r, y: o.top.y + normal.y * r };
  // The centre line reaches the floor's centre line (floorY − r) here.
  const foot = Math.max(0, (o.floorY - r - line.y) / Math.max(1e-6, dir.y));
  const s0 = Math.min(foot, Math.max(0, (o.start.x - line.x) * dir.x + (o.start.y - line.y) * dir.y));
  const top = { x: line.x + dir.x * s0, y: line.y + dir.y * s0 };
  const floorDir: 1 | -1 = dir.x < 0 ? -1 : 1;
  const footX = line.x + dir.x * foot;
  const wallX = floorDir > 0 ? o.width - r : r;
  return { top, dir, normal, slopeLen: foot - s0, floorDir, floorLen: Math.max(0, (wallX - footX) * floorDir), r, k: o.k ?? SOLID_BALL_K };
}

export interface RollState {
  onFloor: boolean;
  /** Distance along the current part of the path, px. */
  s: number;
  /** Speed of the centre along the path, px per step. */
  v: number;
  /** Speed of the ball's surface from its spin, r·ω, px per step (= v while it rolls without slipping). */
  w: number;
  /** Angle rolled so far, radians (forward). */
  turn: number;
  /** Reached the end of the floor. */
  stopped: boolean;
  /** Slipping (sliding while it turns) in the last step. */
  slipping: boolean;
}

export const rollStart = (path: RollPath, v0 = 0): RollState => ({
  onFloor: path.slopeLen <= 0,
  s: 0,
  v: v0,
  w: v0,
  turn: 0,
  stopped: false,
  slipping: false,
});

/** Unit vector along the path at the ball's place. */
export const rollTangent = (p: RollPath, st: RollState): Point => (st.onFloor ? { x: p.floorDir, y: 0 } : p.dir);

/** Ball centre, world px. */
export function rollPosition(p: RollPath, st: RollState): Point {
  if (!st.onFloor) return { x: p.top.x + p.dir.x * st.s, y: p.top.y + p.dir.y * st.s };
  return { x: p.top.x + p.dir.x * p.slopeLen + p.floorDir * st.s, y: p.top.y + p.dir.y * p.slopeLen };
}

/**
 * One physics step. `g` = gravity in px per step² (a vector, so Moon mode and any direction work), `mu` = friction
 * coefficient between ball and ramp / floor, `rr` = rolling resistance (share of g, floor only).
 */
export function rollStep(p: RollPath, st: RollState, g: Point, mu: number, rr = ROLLING_RESISTANCE): void {
  if (st.stopped) return;
  const k = p.k;
  const t = rollTangent(p, st);
  const out = st.onFloor ? { x: 0, y: -1 } : p.normal;
  const gt = g.x * t.x + g.y * t.y;
  const gn = Math.max(0, -(g.x * out.x + g.y * out.y));
  let slip = st.v - st.w;
  if (Math.abs(slip) < 1e-9) {
    // Rolling: friction needed to keep the contact still is gt·k/(1+k); it holds up to μ·gn.
    if (Math.abs(gt) * k <= mu * gn * (1 + k) + 1e-15) {
      let a = gt / (1 + k);
      if (st.onFloor && st.v > 0) a -= rr * gn;
      st.v = st.onFloor ? Math.max(0, st.v + a) : st.v + a;
      st.w = st.v;
      st.slipping = false;
    } else slip = Math.sign(gt) * 1e-9; // starts to slide the way gravity pulls
  }
  if (Math.abs(slip) >= 1e-9) {
    // Sliding: kinetic friction μ·gn against the slip slows the centre and spins the ball up (r·α = −F / k).
    const F = -Math.sign(slip) * mu * gn;
    const v = st.v + gt + F;
    const w = st.w - F / k;
    if (Math.sign(v - w) !== Math.sign(slip)) {
      // The contact stops sliding during this step: from here on it rolls (angular momentum about the contact kept).
      st.v = (st.v + k * st.w + gt) / (1 + k);
      st.w = st.v;
      st.slipping = false;
    } else {
      st.v = v;
      st.w = w;
      st.slipping = true;
    }
  }
  st.s += st.v;
  st.turn += st.w / p.r;
  if (!st.onFloor) {
    if (st.s < 0) {
      st.s = 0;
      st.v = st.w = 0;
    }
    if (st.s >= p.slopeLen) {
      const over = st.s - p.slopeLen;
      const cos = Math.abs(p.dir.x);
      st.onFloor = true;
      st.v = Math.max(0, (st.v * cos + k * st.w) / (1 + k));
      st.w = st.v;
      st.s = over * cos;
    }
  }
  if (st.onFloor && (st.s >= p.floorLen || st.v <= 0)) {
    st.s = Math.min(st.s, p.floorLen);
    st.v = st.w = 0;
    st.stopped = true;
  }
}

/**
 * Measured acceleration down the slope, from the ball's centre as the physics left it each step (px per step²):
 * velocity from successive positions, then (last − first velocity) / steps. Only while it is on the slope; restarts
 * when gravity changes. Null until it has a few steps.
 */
export class SlopeAccelMeter {
  private d: number[] = [];
  private g = NaN;

  reset() {
    this.d = [];
    this.g = NaN;
  }

  /** `along` = position along the slope (px), `g` = gravity used this step (any number that changes with it). */
  push(along: number, g: number) {
    if (g !== this.g) {
      this.d = [];
      this.g = g;
    }
    this.d.push(along);
  }

  value(): number | null {
    const d = this.d;
    if (d.length < 6) return null;
    const v1 = d[1] - d[0], vn = d[d.length - 1] - d[d.length - 2];
    return (vn - v1) / (d.length - 2);
  }
}
