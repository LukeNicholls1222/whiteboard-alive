// Fallback: every drawn object becomes a rigid body and falls onto the ground. Something always moves.
//
// "Always moves" has to hold even when the drawing already reaches the bottom of the photo (nothing to fall onto)
// or is a single flat-bottomed stroke group (it would just sit there). So:
//   - the floor is at the bottom edge of the view, never right under the drawing;
//   - anything that is close to the floor gets a hop: it starts exactly where it was drawn, rises, and falls back
//     (visible from the first frame, lands within ~1.5 s);
//   - every body gets a small spin, so it lands off-balance and tips over instead of settling flat;
//   - once everything has come to rest, it waits a moment and falls again from the start.

import Matter from 'matter-js';
import type { Contour, Point, SceneBuilder, Sprite } from '../types';
import { contourMask, cutSprite, eraseFromPaper, roleOf } from './common';
import { replayWhenStopped } from './replay';
import { STEP_ACCEL } from '../sim';

/** A body whose bottom is closer than this (× view height) to the floor hops first. */
const MIN_DROP = 0.25;
/** Hop height (× view height), limited by the room above the drawing. */
const HOP = 0.2;
/** Initial spin, rad per step. */
const SPIN = 0.025;

/** Is `p` inside (or on) the convex polygon `hull`, whichever way it winds? */
function insideHull(p: Point, hull: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const s = Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    if (!s) continue;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

export const buildFallback: SceneBuilder = (input) => {
  const { width: W, height: H } = input;
  const bodies: Matter.Body[] = [];
  const sprites: Sprite[] = [];
  const masks: Uint8Array[] = [];
  const moving: Matter.Body[] = [];

  const addBody = (hull: { x: number; y: number }[], bbox: { x: number; y: number }, isStatic: boolean, mask: Uint8Array | null) => {
    const body = Matter.Bodies.fromVertices(0, 0, [hull], { isStatic, friction: 0.4, restitution: 0.3 });
    if (!body) return;
    // fromVertices recentres on the centre of mass; move it back over the drawing.
    const hb = body.bounds;
    Matter.Body.translate(body, { x: bbox.x - hb.min.x, y: bbox.y - hb.min.y });
    bodies.push(body);
    if (isStatic || !mask) return;
    moving.push(body);
    masks.push(mask);
    sprites.push({
      ...cutSprite(input, mask),
      follow: { kind: 'body', body, origin: { ...body.position }, originAngle: body.angle },
    });
  };

  const isStaticContour = (c: Contour) => {
    const r = roleOf(input, c.id);
    return !!r && (r.role === 'ground' || r.role === 'incline');
  };
  // A stroke drawn inside another one (the axle dot in a cannon wheel) is part of it, not a body of its own:
  // as a separate body it would start inside the other's solid hull, and the two would push each other
  // around forever. It moves with the smallest outline that contains it (or stays on paper if that is static).
  const parentOf = new Map<Contour, Contour>();
  for (const c of input.contours) {
    if (isStaticContour(c) || !c.hull.length) continue;
    let best: Contour | null = null;
    for (const d of input.contours) {
      if (d === c || d.hull.length < 3 || d.area <= c.area) continue;
      if (!c.hull.every((p) => insideHull(p, d.hull))) continue;
      if (!best || d.area < best.area) best = d;
    }
    if (best) parentOf.set(c, best);
  }
  const rootOf = (c: Contour) => {
    let r = c;
    for (let p = parentOf.get(r); p; p = parentOf.get(r)) r = p;
    return r;
  };

  for (const c of input.contours) {
    if (parentOf.has(c) || c.hull.length < 3) continue;
    const isStatic = isStaticContour(c);
    const group = input.contours.filter((k) => rootOf(k) === c);
    addBody(c.hull, c.bbox, isStatic, isStatic ? null : contourMask(input, group));
  }

  // Nothing movable (all lines, or everything marked static): drop the whole drawing as one box.
  if (!moving.length && input.contours.length) {
    const x0 = Math.min(...input.contours.map((c) => c.bbox.x));
    const y0 = Math.min(...input.contours.map((c) => c.bbox.y));
    const x1 = Math.max(...input.contours.map((c) => c.bbox.x + c.bbox.w));
    const y1 = Math.max(...input.contours.map((c) => c.bbox.y + c.bbox.h));
    const hull = [
      { x: x0, y: y0 },
      { x: Math.max(x1, x0 + 4), y: y0 },
      { x: Math.max(x1, x0 + 4), y: Math.max(y1, y0 + 4) },
      { x: x0, y: Math.max(y1, y0 + 4) },
    ];
    addBody(hull, { x: x0, y: y0 }, false, contourMask(input, input.contours));
  }

  // Floor top at the bottom edge of the view.
  const floorTop = H - 2;
  const opts = { isStatic: true, friction: 0.6 };
  bodies.push(
    Matter.Bodies.rectangle(W / 2, floorTop + 50, W * 3, 100, opts),
    Matter.Bodies.rectangle(-50, H / 2, 100, H * 4, opts),
    Matter.Bodies.rectangle(W + 50, H / 2, 100, H * 4, opts),
  );

  moving.forEach((body, i) => {
    const b = body.bounds;
    // If it is resting below the floor line already (drawn to the very bottom), lift it onto the floor.
    if (b.max.y > floorTop) Matter.Body.translate(body, { x: 0, y: floorTop - b.max.y });
    const gap = floorTop - body.bounds.max.y;
    let vy = 0;
    if (gap < MIN_DROP * H) {
      const room = Math.max(0, body.bounds.min.y - 0.02 * H);
      const hop = Math.min(HOP * H, room);
      // v² = 2 g h, in Matter's per-step units.
      if (hop > 4) vy = -Math.sqrt(2 * STEP_ACCEL * hop);
    }
    // Drift towards the middle so wide drawings do not just slide into a wall.
    const vx = (W / 2 - (b.min.x + b.max.x) / 2) / W;
    Matter.Body.setVelocity(body, { x: vx, y: vy });
    Matter.Body.setAngularVelocity(body, (i % 2 ? -1 : 1) * SPIN);
  });

  return {
    bodies,
    constraints: [],
    sprites,
    background: eraseFromPaper(input, masks),
    label: 'Falling objects',
    onStep: replayWhenStopped(moving),
    // Fastest on hitting the floor: v² = v₀² + 2g·(drop height), the highest of all the falling bodies.
    speedHint: Math.max(0, ...moving.map((b) => Math.sqrt(b.velocity.x ** 2 + b.velocity.y ** 2 + 2 * STEP_ACCEL * ((input.analysis.params.gravity || 9.8) / 9.8) * Math.max(0, floorTop - b.bounds.max.y)))),
  };
};
