// Fallback: every drawn object becomes a rigid body and falls onto the ground. Something always moves.

import Matter from 'matter-js';
import type { SceneBuilder, Sprite } from '../types';
import { contourMask, cutSprite, eraseFromPaper, roleOf } from './common';

export const buildFallback: SceneBuilder = (input) => {
  const { width: W, height: H } = input;
  const bodies: Matter.Body[] = [];
  const sprites: Sprite[] = [];
  const masks: Uint8Array[] = [];

  for (const c of input.contours) {
    const r = roleOf(input, c.id);
    const isStatic = !!r && (r.role === 'ground' || r.role === 'incline');
    if (c.hull.length < 3) continue;
    const body = Matter.Bodies.fromVertices(c.centroid.x, c.centroid.y, [c.hull], {
      isStatic,
      friction: 0.4,
      restitution: 0.2,
    });
    if (!body) continue;
    // fromVertices recentres on the centre of mass; move it back over the drawing.
    const hb = body.bounds;
    Matter.Body.translate(body, { x: c.bbox.x - hb.min.x, y: c.bbox.y - hb.min.y });
    bodies.push(body);
    if (isStatic) continue;
    const mask = contourMask(input, [c]);
    masks.push(mask);
    sprites.push({
      ...cutSprite(input, mask),
      follow: { kind: 'body', body, origin: { ...body.position }, originAngle: body.angle },
    });
  }

  const floorY = Math.min(H + 20, Math.max(...input.contours.map((c) => c.bbox.y + c.bbox.h), H * 0.6) + 40);
  const opts = { isStatic: true, friction: 0.6 };
  bodies.push(
    Matter.Bodies.rectangle(W / 2, floorY + 50, W * 3, 100, opts),
    Matter.Bodies.rectangle(-50, H / 2, 100, H * 4, opts),
    Matter.Bodies.rectangle(W + 50, H / 2, 100, H * 4, opts),
  );

  return { bodies, constraints: [], sprites, background: eraseFromPaper(input, masks), label: 'Falling objects' };
};
