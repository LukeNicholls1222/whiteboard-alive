// Pendulum: the drawn string and bob swing rigidly around the pivot, exactly as drawn.

import Matter from 'matter-js';
import type { Point, SceneBuilder } from '../types';
import { contourMask, cutSprite, deepestPoint, eraseFromPaper, roleOf } from './common';
import { STEP_ACCEL } from '../sim';

const STIFFNESS = 1;
const DAMPING = 0;
const KICK_DEG = 20;

export const buildPendulum: SceneBuilder = (input) => {
  const { width: W, height: H } = input;
  const fixed = input.contours.filter((c) => {
    const r = roleOf(input, c.id);
    return r && (r.role === 'pivot' || r.role === 'ground' || (r.static && r.role !== 'bob' && r.role !== 'rope'));
  });
  let moving = input.contours.filter((c) => !fixed.includes(c));
  if (!moving.length) moving = input.contours;

  const all = contourMask(input, input.contours);
  const movingMask = contourMask(input, moving);

  // Bob = thickest part of the moving drawing (drawn circles are filled by the contour mask).
  const { point: bob, radius: depth } = deepestPoint(movingMask, W, H);
  const bobRadius = Math.max(10, depth);

  const pivot = traceString(all, W, H, bob, bobRadius);

  // The swinging part = bob disc + a band along the string. Everything else (ceiling) stays as background.
  const band = Math.max(12, bobRadius * 0.4);
  const swing = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!all[i]) continue;
      const inBob = Math.hypot(x - bob.x, y - bob.y) <= bobRadius * 1.25;
      if (inBob || distToSegment({ x, y }, pivot, bob) <= band) swing[i] = 1;
    }

  const length = Math.hypot(bob.x - pivot.x, bob.y - pivot.y);
  const body = Matter.Bodies.circle(bob.x, bob.y, bobRadius, { frictionAir: 0.0008, friction: 0, restitution: 0 });
  const rope = Matter.Constraint.create({ pointA: { ...pivot }, bodyB: body, length, stiffness: STIFFNESS, damping: DAMPING });

  // Never show a still pendulum: if it hangs straight down, give it ~KICK_DEG of swing.
  const angle = Math.atan2(bob.x - pivot.x, bob.y - pivot.y);
  if (Math.abs(angle) < (8 * Math.PI) / 180) {
    const v = Math.sqrt(2 * STEP_ACCEL * length * (1 - Math.cos((KICK_DEG * Math.PI) / 180)));
    Matter.Body.setVelocity(body, { x: v, y: 0 });
  }

  return {
    bodies: [body],
    constraints: [rope],
    sprites: [
      {
        ...cutSprite(input, swing),
        follow: { kind: 'swing', pivot, body, originAngle: Math.atan2(bob.y - pivot.y, bob.x - pivot.x), originLength: length },
      },
    ],
    background: eraseFromPaper(input, [swing]),
    label: 'Pendulum',
  };
};

/**
 * Walk from the bob up along the string. Stops where the ink ends (free pivot point)
 * or where the line suddenly widens (it hit the ceiling). Returns the pivot.
 */
function traceString(mask: Uint8Array, W: number, H: number, bob: Point, r: number): Point {
  const at = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < W && yi < H && mask[yi * W + xi] === 1;
  };

  // Initial direction: centroid of ink in a ring just outside the bob, upper half preferred.
  let sx = 0, sy = 0, n = 0;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 90)
    for (let rr = r * 1.4; rr <= r * 2.2; rr += 2) {
      const x = bob.x + Math.cos(a) * rr, y = bob.y + Math.sin(a) * rr;
      if (y < bob.y && at(x, y)) {
        sx += x - bob.x;
        sy += y - bob.y;
        n++;
      }
    }
  let dir = n ? normalize({ x: sx, y: sy }) : { x: 0, y: -1 };

  let p = { x: bob.x + dir.x * r * 1.3, y: bob.y + dir.y * r * 1.3 };
  let last = { ...p };
  const widths: number[] = [];
  const maxGap = Math.max(10, r * 0.6);
  let gap = 0;
  for (let step = 0; step < W + H; step++) {
    p = { x: p.x + dir.x * 2, y: p.y + dir.y * 2 };
    // Perpendicular scan to find the ink centre and width at this point.
    const perp = { x: -dir.y, y: dir.x };
    let lo = Infinity, hi = -Infinity;
    for (let t = -r * 1.5; t <= r * 1.5; t += 1) if (at(p.x + perp.x * t, p.y + perp.y * t)) {
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    if (lo === Infinity) {
      gap += 2;
      if (gap > maxGap) break;
      continue;
    }
    gap = 0;
    const width = hi - lo;
    const median = widths.length ? [...widths].sort((a, b) => a - b)[widths.length >> 1] : width;
    if (widths.length > 8 && width > median * 3 + 6) {
      // Hit the ceiling: put the pivot in the middle of the ceiling stroke, not at its lower edge.
      let q = { ...p };
      for (let k = 0; k < r * 2 && at(q.x, q.y); k++) q = { x: q.x + dir.x, y: q.y + dir.y };
      last = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      break;
    }
    widths.push(width);
    const mid = (lo + hi) / 2;
    p = { x: p.x + perp.x * mid, y: p.y + perp.y * mid };
    // Follow the line, but only slowly so hatching cannot drag the direction around.
    const toP = normalize({ x: p.x - bob.x, y: p.y - bob.y });
    dir = normalize({ x: dir.x * 0.8 + toP.x * 0.2, y: dir.y * 0.8 + toP.y * 0.2 });
    last = { ...p };
  }
  if (Math.hypot(last.x - bob.x, last.y - bob.y) < r * 2) return { x: bob.x, y: Math.max(0, bob.y - 4 * r) };
  return last;
}

function normalize(v: Point): Point {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
