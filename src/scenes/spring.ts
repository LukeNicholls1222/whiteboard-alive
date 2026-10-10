// Spring + mass: the drawn zigzag is a Matter constraint between a fixed end and the drawn block.
// The block oscillates along the spring's axis (vertical hanging spring, or horizontal spring on a floor);
// the zigzag cut-out stretches and squashes between its two ends.

import Matter from 'matter-js';
import type { BBox, Contour, Point, SceneBuilder, SceneInput, Sprite } from '../types';
import { contourMask, cutSprite, deepestPoint, eraseFromPaper, maskBounds, roleOf } from './common';
import { STEP_ACCEL, STEP_MS } from '../sim';

// Fixed per diagram type; never chosen by the AI.
const STIFFNESS = 0.0015;
const DAMPING = 0;
const FRICTION_AIR = 0.001;
/** Measured for Matter 0.20 (2 constraint iterations): omega² per step² ≈ 6.6 × stiffness. Period ≈ 1 s here. */
const OMEGA2 = 6.6 * STIFFNESS;
/** Oscillation amplitude as a fraction of the drawn spring length (clamped below). */
const KICK_FRACTION = 0.25;
const KICK_MIN_PX = 12;
const KICK_MAX_PX = 80;

const FIXED_ROLES = new Set(['pivot', 'ground', 'incline', 'wheel', 'cannon']);
const MASS_ROLES = new Set(['mass', 'bob', 'projectile']);

/** Per-row (vertical axis) or per-column (horizontal axis) extent of a mask, in the axis frame (u along, v across). */
function spans(mask: Uint8Array, W: number, H: number, vertical: boolean) {
  const n = vertical ? H : W;
  const lo = new Int32Array(n).fill(-1);
  const hi = new Int32Array(n).fill(-1);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const u = vertical ? y : x;
      const v = vertical ? x : y;
      if (lo[u] < 0 || v < lo[u]) lo[u] = v;
      if (v > hi[u]) hi[u] = v;
    }
  const width = (u: number) => (lo[u] < 0 ? 0 : hi[u] - lo[u] + 1);
  return { lo, hi, width, n };
}

function centroidOf(mask: Uint8Array, W: number): Point | null {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      sx += i % W;
      sy += (i / W) | 0;
      n++;
    }
  return n ? { x: sx / n, y: sy / n } : null;
}

const count = (mask: Uint8Array) => mask.reduce((s, v) => s + v, 0);

function bboxGap(a: BBox, b: BBox) {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

/** Without AI roles: the biggest, squarest closed shape is the weight. */
function guessMass(pool: Contour[]): Contour | undefined {
  const score = (c: Contour) => {
    const sq = Math.min(c.bbox.w, c.bbox.h) / Math.max(1, c.bbox.w, c.bbox.h);
    return c.area * sq * (c.hasHole ? 1.5 : 1);
  };
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

/** Without AI roles: whatever touches (or nearly touches) the weight is the spring. */
function guessSpring(pool: Contour[], mass: Contour[]): Contour[] {
  if (!pool.length || !mass.length) return [];
  const mb = mass[0].bbox;
  const reach = 0.5 * Math.max(mb.w, mb.h) + 20;
  // A long thin line running past the block on both sides is a floor or ceiling, not the spring.
  const isLine = (c: Contour) =>
    (c.bbox.h < 0.3 * c.bbox.w && c.bbox.x < mb.x - 10 && c.bbox.x + c.bbox.w > mb.x + mb.w + 10) ||
    (c.bbox.w < 0.3 * c.bbox.h && c.bbox.y < mb.y - 10 && c.bbox.y + c.bbox.h > mb.y + mb.h + 10);
  const near = pool.filter((c) => !isLine(c) && mass.some((m) => bboxGap(c.bbox, m.bbox) < reach));
  if (near.length) return near;
  return [[...pool].sort((a, b) => b.inkPixels - a.inkPixels)[0]];
}

/** Spring and block drawn as one stroke: the block is the thick band around the deepest point along the long axis. */
function splitMerged(input: SceneInput, mask: Uint8Array) {
  const { width: W, height: H } = input;
  const b = maskBounds(mask, W, H);
  if (!b) return null;
  const vertical = b.h >= b.w;
  const sp = spans(mask, W, H, vertical);
  const { point } = deepestPoint(mask, W, H);
  const du = vertical ? point.y : point.x;
  const ref = sp.width(du);
  if (!ref) return null;
  let u0 = du, u1 = du;
  while (u0 > 0 && sp.width(u0 - 1) >= 0.7 * ref) u0--;
  while (u1 < sp.n - 1 && sp.width(u1 + 1) >= 0.7 * ref) u1++;
  const extent = vertical ? b.h : b.w;
  if (u1 - u0 + 1 > 0.85 * extent) return null;
  const mass = new Uint8Array(mask.length);
  const spring = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const u = vertical ? (i / W) | 0 : i % W;
    if (u >= u0 && u <= u1) mass[i] = 1;
    else spring[i] = 1;
  }
  if (count(spring) < 40) return null;
  return { mass, spring };
}

/** Cut wide end rows/columns off a block mask (a floor or wall drawn in the same stroke). Returns true if anything was cut. */
function trimFlanges(mask: Uint8Array, W: number, H: number): boolean {
  let cut = false;
  for (const vertical of [true, false]) {
    const sp = spans(mask, W, H, vertical);
    const us: number[] = [];
    for (let u = 0; u < sp.n; u++) if (sp.width(u) > 0) us.push(u);
    if (us.length < 5) continue;
    const median = us.map((u) => sp.width(u)).sort((a, b) => a - b)[us.length >> 1];
    const wide = (u: number) => sp.width(u) > 1.6 * median + 4;
    const drop: number[] = [];
    for (let k = 0; k < us.length * 0.4 && wide(us[k]); k++) drop.push(us[k]);
    for (let k = us.length - 1; k > us.length * 0.6 && wide(us[k]); k--) drop.push(us[k]);
    for (const u of drop) for (let v = sp.lo[u]; v <= sp.hi[u]; v++) mask[vertical ? u * W + v : v * W + u] = 0;
    if (drop.length) cut = true;
  }
  return cut;
}

export const buildSpring: SceneBuilder = (input) => {
  const { width: W, height: H, contours } = input;
  if (!contours.length) throw new Error('spring: no contours');
  const role = (c: Contour) => roleOf(input, c.id);

  const fixed = contours.filter((c) => {
    const r = role(c);
    return !!r && (FIXED_ROLES.has(r.role) || (r.static && r.role !== 'spring' && !MASS_ROLES.has(r.role)));
  });
  const free = contours.filter((c) => !fixed.includes(c));
  const pool = free.length ? free : contours;

  let massC = pool.filter((c) => MASS_ROLES.has(role(c)?.role ?? ''));
  if (!massC.length) massC = [guessMass(pool)!];
  const rest = pool.filter((c) => !massC.includes(c));
  let springC = rest.filter((c) => role(c)?.role === 'spring');
  if (!springC.length) springC = guessSpring(rest, massC);

  // Ink of everything else (ceiling, floor, wall) stays put, even where it touches the block or spring.
  const others = contours.filter((c) => !massC.includes(c) && !springC.includes(c));
  const otherMask = others.length ? contourMask(input, others, 1) : null;
  const notOther = (m: Uint8Array) => {
    if (otherMask) for (let i = 0; i < m.length; i++) if (otherMask[i]) m[i] = 0;
    return m;
  };

  let massMask = notOther(contourMask(input, massC));
  // useRect: the block's outline isn't a single clean contour, so its body is the box around its mask.
  let useRect = false;
  let springMask: Uint8Array | null = null;
  if (springC.length) {
    springMask = notOther(contourMask(input, springC));
    for (let i = 0; i < springMask.length; i++) if (massMask[i]) springMask[i] = 0;
    if (count(springMask) < 40) springMask = null;
  }
  if (!springMask) {
    const split = splitMerged(input, massMask);
    if (split) {
      massMask = split.mass;
      springMask = split.spring;
      useRect = true;
    }
  }
  if (trimFlanges(massMask, W, H)) useRect = true;

  const mb = maskBounds(massMask, W, H) ?? massC[0].bbox;
  const cm = centroidOf(massMask, W) ?? massC[0].centroid;

  // Spring ends: anchor (fixed, away from the block) and attach (on the block side).
  let anchor: Point;
  let attach: Point;
  let vertical = true;
  let haveSpringSprite = false;
  const cs = springMask ? centroidOf(springMask, W) : null;
  if (springMask && cs) {
    vertical = Math.abs(cm.y - cs.y) >= Math.abs(cm.x - cs.x);
    const sp = spans(springMask, W, H, vertical);
    const massPlus = (vertical ? cm.y - cs.y : cm.x - cs.x) > 0;
    const us: number[] = [];
    for (let u = 0; u < sp.n; u++) if (sp.width(u) > 0) us.push(u);
    if (!massPlus) us.reverse(); // us[0] = far (fixed) end, us[last] = block end
    // A ceiling / wall drawn joined to the spring shows up as much wider rows at the far end: leave it in the background.
    const widths = us.map((u) => sp.width(u)).sort((a, b) => a - b);
    const median = widths[widths.length >> 1] || 1;
    let k = 0;
    while (k < us.length * 0.6 && sp.width(us[k]) > Math.max(2.5 * median, 8)) k++;
    for (let j = 0; j < k; j++) {
      const u = us[j];
      for (let v = sp.lo[u]; v <= sp.hi[u]; v++) springMask[vertical ? u * W + v : v * W + u] = 0;
    }
    const kept = us.slice(k);
    const at = (u: number): Point => {
      const v = (sp.lo[u] + sp.hi[u]) / 2;
      return vertical ? { x: v, y: u } : { x: u, y: v };
    };
    anchor = at(kept[0]);
    attach = at(kept[kept.length - 1]);
    haveSpringSprite = Math.hypot(attach.x - anchor.x, attach.y - anchor.y) >= 8;
  } else {
    anchor = { x: cm.x, y: mb.y };
    attach = anchor;
  }
  if (!haveSpringSprite) {
    // No usable spring found: hang the block from an invisible spring above it so it still bounces.
    attach = { x: cm.x, y: mb.y };
    anchor = { x: cm.x, y: mb.y - Math.max(60, mb.h * 1.5) };
    vertical = true;
  }

  // Block body: the drawn outline's convex hull when we have it, else the block's bounding box.
  const bodyOpts = { friction: 0, frictionStatic: 0, frictionAir: FRICTION_AIR, restitution: 0 };
  let body: Matter.Body | undefined;
  if (!useRect && massC.length === 1 && massC[0].hull.length >= 3) {
    const c = massC[0];
    body = Matter.Bodies.fromVertices(c.centroid.x, c.centroid.y, [c.hull], bodyOpts);
    if (body) {
      const hb = body.bounds;
      Matter.Body.translate(body, { x: c.bbox.x - hb.min.x, y: c.bbox.y - hb.min.y });
    }
  }
  if (!body) body = Matter.Bodies.rectangle(mb.x + mb.w / 2, mb.y + mb.h / 2, Math.max(8, mb.w), Math.max(8, mb.h), bodyOpts);
  Matter.Body.setInertia(body, Infinity); // slides along the spring, never tumbles

  const L0 = Math.hypot(attach.x - anchor.x, attach.y - anchor.y);
  const dir = { x: (attach.x - anchor.x) / L0, y: (attach.y - anchor.y) / L0 };
  // Rest length chosen so the drawing is the equilibrium under normal gravity (a hanging spring doesn't just sag).
  const restLength = Math.max(0.3 * L0, L0 - (STEP_ACCEL * dir.y) / OMEGA2);
  const spring = Matter.Constraint.create({
    pointA: { ...anchor },
    bodyB: body,
    pointB: { x: attach.x - body.position.x, y: attach.y - body.position.y },
    length: restLength,
    stiffness: STIFFNESS,
    damping: DAMPING,
  });

  // Invisible guide rails either side of the block keep the motion one-dimensional along the spring.
  const bb = body.bounds;
  const T = 40, gap = 1;
  const railLen = 4 * (L0 + Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y)) + 400;
  const railOpts = { isStatic: true, friction: 0, frictionStatic: 0, restitution: 0 };
  const rails = vertical
    ? [
        Matter.Bodies.rectangle(bb.min.x - gap - T / 2, body.position.y, T, railLen, railOpts),
        Matter.Bodies.rectangle(bb.max.x + gap + T / 2, body.position.y, T, railLen, railOpts),
      ]
    : [
        Matter.Bodies.rectangle(body.position.x, bb.min.y - gap - T / 2, railLen, T, railOpts),
        Matter.Bodies.rectangle(body.position.x, bb.max.y + gap + T / 2, railLen, T, railOpts),
      ];

  // Never start still: kick it along the spring.
  const omega = Math.sqrt(OMEGA2);
  const amp = Math.min(0.6 * restLength, Math.max(KICK_MIN_PX, Math.min(KICK_MAX_PX, KICK_FRACTION * L0)));
  Matter.Body.setVelocity(body, { x: dir.x * amp * omega, y: dir.y * amp * omega });

  // Matter's soft constraints bleed energy (~90% amplitude lost in 10 s). Top it back up so it never stops.
  const targetEnergy = 0.5 * OMEGA2 * amp * amp;
  const step = (engine: Matter.Engine) => {
    const g = engine.gravity;
    const ga = (g.x * dir.x + g.y * dir.y) * g.scale * STEP_MS * STEP_MS; // gravity along the spring, px/step²
    const end = Matter.Constraint.pointBWorld(spring);
    const len = (end.x - anchor.x) * dir.x + (end.y - anchor.y) * dir.y;
    const d = len - (restLength + ga / OMEGA2);
    const vel = Matter.Body.getVelocity(body!);
    const va = vel.x * dir.x + vel.y * dir.y;
    const e = 0.5 * va * va + 0.5 * OMEGA2 * d * d;
    if (e >= targetEnergy) return;
    if (Math.abs(va) < 0.05) {
      // Sitting still (e.g. right after a gravity change): give it a fresh kick.
      if (Math.abs(d) < 0.5 * amp) Matter.Body.setVelocity(body!, { x: vel.x + dir.x * amp * omega, y: vel.y + dir.y * amp * omega });
      return;
    }
    const f = Math.min(1.02, Math.sqrt(1 + (targetEnergy - e) / (0.5 * va * va)));
    Matter.Body.setVelocity(body!, { x: vel.x + dir.x * va * (f - 1), y: vel.y + dir.y * va * (f - 1) });
  };

  const sprites: Sprite[] = [];
  const masks: Uint8Array[] = [massMask];
  if (springMask && haveSpringSprite) {
    masks.push(springMask);
    sprites.push({ ...cutSprite(input, springMask), follow: { kind: 'stretch', anchor: { ...anchor }, constraint: spring, origin: { ...attach } } });
  }
  sprites.push({ ...cutSprite(input, massMask), follow: { kind: 'body', body, origin: { ...body.position }, originAngle: body.angle } });

  return {
    bodies: [body, ...rails],
    constraints: [spring],
    sprites,
    background: eraseFromPaper(input, masks),
    label: 'Spring and mass',
    step,
  };
};
