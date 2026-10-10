// Pendulum: everything that moves swings rigidly around the pivot, exactly as drawn.

import Matter from 'matter-js';
import type { SceneBuilder } from '../types';
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

  const mask = contourMask(input, moving);

  // Bob = thickest part of the moving drawing.
  const { point: bob, radius: depth } = deepestPoint(mask, W, H);
  const bobRadius = Math.max(10, depth);

  // Pivot = where the drawing narrows to a string at its top. If a ceiling is drawn connected, cut it off.
  const rows: { y: number; xs: number[] }[] = [];
  for (let y = 0; y < bob.y; y++) {
    const xs: number[] = [];
    for (let x = 0; x < W; x++) if (mask[y * W + x]) xs.push(x);
    if (xs.length) rows.push({ y, xs });
  }
  let pivot = { x: bob.x, y: Math.max(0, bob.y - 200) };
  let cutY = 0;
  if (rows.length) {
    const narrow = Math.max(12, bobRadius * 0.8);
    const top = rows[0];
    const span = (r: { xs: number[] }) => r.xs[r.xs.length - 1] - r.xs[0];
    let idx = 0;
    if (span(top) > narrow * 2) {
      // Ceiling connected: scan down until the row is string-thin.
      idx = rows.findIndex((r) => span(r) <= narrow);
      if (idx < 0) idx = 0;
    }
    const r = rows[idx];
    pivot = { x: r.xs.reduce((s, v) => s + v, 0) / r.xs.length, y: r.y };
    cutY = idx > 0 ? r.y : 0;
  }
  if (cutY > 0) for (let i = 0; i < cutY * W; i++) mask[i] = 0;

  const length = Math.hypot(bob.x - pivot.x, bob.y - pivot.y);
  const body = Matter.Bodies.circle(bob.x, bob.y, bobRadius, { frictionAir: 0.0008, friction: 0, restitution: 0 });
  const rope = Matter.Constraint.create({
    pointA: { ...pivot },
    bodyB: body,
    length,
    stiffness: STIFFNESS,
    damping: DAMPING,
  });

  // Never draw a still pendulum: if it hangs straight down, push it to ~KICK_DEG of swing.
  const angle = Math.atan2(bob.x - pivot.x, bob.y - pivot.y);
  if (Math.abs(angle) < (8 * Math.PI) / 180) {
    const v = Math.sqrt(2 * STEP_ACCEL * length * (1 - Math.cos((KICK_DEG * Math.PI) / 180)));
    Matter.Body.setVelocity(body, { x: v, y: 0 });
  }

  const sprite = cutSprite(input, mask);
  return {
    bodies: [body],
    constraints: [rope],
    sprites: [
      {
        ...sprite,
        follow: { kind: 'swing', pivot, body, originAngle: Math.atan2(bob.y - pivot.y, bob.x - pivot.x), originLength: length },
      },
    ],
    background: eraseFromPaper(input, [mask]),
    label: 'Pendulum',
  };
};
