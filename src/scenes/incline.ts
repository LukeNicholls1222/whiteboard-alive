// Incline: a drawn triangle becomes a static ramp, the drawn block on it slides down (and may stop by friction).

import Matter from 'matter-js';
import type { Contour, Point, SceneBuilder, SceneInput, Sprite } from '../types';
import { contourMask, cutSprite, eraseFromPaper, roleOf } from './common';
import { STEP_ACCEL } from '../sim';

/** Coulomb friction coefficient μ used when the AI gives no `params.friction`. */
const DEFAULT_FRICTION = 0.3;
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

function pickIncline(input: SceneInput, usable: Contour[]): Contour | null {
  const byRole = usable.filter((c) => roleOf(input, c.id)?.role === 'incline');
  const pool = byRole.length ? byRole : usable;
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

function pickBlocks(input: SceneInput, usable: Contour[], incline: Contour, slope: Slope): Contour[] {
  const others = usable.filter((c) => c !== incline);
  const byRole = others.filter((c) => {
    const r = roleOf(input, c.id)?.role;
    return r === 'mass' || r === 'projectile';
  });
  if (byRole.length) return byRole;
  // No roles: the smaller drawing closest to (and above) the slope is the block.
  const candidates = others.filter((c) => {
    const r = roleOf(input, c.id);
    return !(r && (r.role === 'ground' || r.role === 'incline' || r.static)) && polyArea(c.hull) < polyArea(incline.hull);
  });
  let best: Contour | null = null, bestCost = Infinity;
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

export const buildIncline: SceneBuilder = (input) => {
  const { width: W, height: H } = input;
  const usable = input.contours.filter((c) => c.hull.length >= 3);
  const incline = pickIncline(input, usable);
  const tri = incline && bestTriangle(incline.hull);
  if (!incline || !tri) throw new Error('incline: no ramp-like contour');
  const slope = slopeOf(tri.tri);
  const blocks = pickBlocks(input, usable, incline, slope);
  if (!blocks.length) throw new Error('incline: no block found');

  const mu = Math.max(0, Math.min(1.5, input.analysis.params.friction ?? DEFAULT_FRICTION));
  // Matter's own friction is off on every incline surface; applyFriction() does the real work.
  const surface = { friction: 0, frictionStatic: 0, restitution: 0 };
  hookFriction();

  // Static ramp built from the 3 corners (a triangle's centre of mass is its vertex mean).
  const [a, b, c] = tri.tri;
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
  const sprites: Sprite[] = [];
  const masks: Uint8Array[] = [];

  for (const blk of blocks) {
    const body = Matter.Bodies.fromVertices(blk.centroid.x, blk.centroid.y, [blk.hull], {
      ...surface,
      frictionAir: 0.001,
      plugin: { inclineMu: mu },
    });
    if (!body) continue;
    frictionBodies.add(body);
    const hb = body.bounds;
    Matter.Body.translate(body, { x: blk.bbox.x - hb.min.x, y: blk.bbox.y - hb.min.y });
    Matter.Body.setInertia(body, body.inertia * INERTIA_SCALE);

    // Snap a block that floats a little above / sinks a little into the slope onto it.
    // Body and sprite are shifted by the same vector so the drawing stays glued to the physics.
    let shift = { x: 0, y: 0 };
    const gap = clearance(blk.hull, slope);
    const size = Math.max(blk.bbox.w, blk.bbox.h);
    const t = along(blk.centroid, slope);
    if (t > -0.1 && t < 1.1 && Math.abs(gap) <= Math.max(SNAP_PX, size * SNAP_BLOCK_FRACTION)) {
      const d = 1 - gap; // leave 1 px of air so it does not start interpenetrating
      shift = { x: slope.normal.x * d, y: slope.normal.y * d };
      Matter.Body.translate(body, shift);
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
    const mask = contourMask(input, [blk]);
    masks.push(mask);
    const cut = cutSprite(input, mask);
    sprites.push({
      image: cut.image,
      offset: { x: cut.offset.x + shift.x, y: cut.offset.y + shift.y },
      follow: { kind: 'body', body, origin: { ...body.position }, originAngle: body.angle },
    });
  }
  if (bodies.length < 2) throw new Error('incline: block bodies could not be built');

  // Floor at the ramp's base and walls at the image edges keep the block on screen.
  const floorY = Math.min(H, Math.max(a.y, b.y, c.y));
  const wallOpts = { isStatic: true, ...surface };
  bodies.push(
    Matter.Bodies.rectangle(W / 2, floorY + 50, W * 3, 100, wallOpts),
    Matter.Bodies.rectangle(-50, H / 2, 100, H * 4, wallOpts),
    Matter.Bodies.rectangle(W + 50, H / 2, 100, H * 4, wallOpts),
  );

  // The ramp stays in the background exactly as drawn; only the moving blocks are erased.
  return { bodies, constraints: [], sprites, background: eraseFromPaper(input, masks), label: 'Incline' };
};
