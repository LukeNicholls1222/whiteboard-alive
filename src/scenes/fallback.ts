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

/**
 * The darkest part of a photo nobody found lines in: a square window (40 % of the short side) that holds the most
 * "darker than the paper" weight, preferring the middle and keeping off the photo edges (desk, paper border),
 * then tightened to the dark pixels inside it. Plain paper gives the middle of the photo.
 */
function darkestPatch(photo: HTMLCanvasElement): { x: number; y: number; w: number; h: number } {
  const W = photo.width, H = photo.height, minSide = Math.min(W, H);
  const d = photo.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const luma = new Uint8Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0; i < luma.length; i++) {
    luma[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    const x = i % W, y = (i - x) / W;
    if (x > W * 0.2 && x < W * 0.8 && y > H * 0.2 && y < H * 0.8) hist[luma[i]]++;
  }
  // Paper brightness: the median of the middle of the photo.
  let total = 0, acc = 0, paper = 255;
  for (const v of hist) total += v;
  for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= total / 2) { paper = v; break; }
  const weight = (i: number) => Math.max(0, paper - 25 - luma[i]);
  // Integral image of the darkness weight.
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += weight(y * W + x);
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const sum = (x: number, y: number, w: number, h: number) =>
    S[(y + h) * (W + 1) + x + w] - S[y * (W + 1) + x + w] - S[(y + h) * (W + 1) + x] + S[y * (W + 1) + x];
  const side = Math.round(minSide * 0.4), margin = Math.round(minSide * 0.05);
  const middle = { x: Math.round((W - side) / 2), y: Math.round((H - side) / 2), w: side, h: side };
  let best = middle, bestScore = 0;
  const far = Math.hypot(W, H) / 2;
  for (let y = margin; y + side <= H - margin; y += 8)
    for (let x = margin; x + side <= W - margin; x += 8) {
      const off = Math.hypot(x + side / 2 - W / 2, y + side / 2 - H / 2) / far;
      const score = sum(x, y, side, side) * (1 - 0.5 * off);
      if (score > bestScore) { bestScore = score; best = { x, y, w: side, h: side }; }
    }
  // Too faint to mean anything (blank paper): the middle.
  if (bestScore < side * side * 0.5) return middle;
  // Tighten to the dark pixels in the window, keeping a little paper around them and a sensible size.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = best.y; y < best.y + best.h; y++)
    for (let x = best.x; x < best.x + best.w; x++)
      if (weight(y * W + x) > 10) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
  if (x1 < 0) return best;
  const pad = Math.round(minSide * 0.03), minW = Math.round(minSide * 0.15);
  const grow = (lo: number, hi: number, limit: number) => {
    let a = lo - pad, b = hi + pad;
    if (b - a < minW) { const c = (a + b) / 2; a = c - minW / 2; b = c + minW / 2; }
    a = Math.max(0, Math.round(a));
    b = Math.min(limit, Math.round(b));
    return [a, b - a] as const;
  };
  const [x, w] = grow(x0, x1, W), [y, h] = grow(y0, y1, H);
  return { x, y, w, h };
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

  // No lines found at all (faint pencil, an odd photo, blank paper): the darkest patch of the photo, or its middle,
  // falls as one block, so the screen never stays still.
  if (!input.contours.length) {
    const b = darkestPatch(input.paper);
    const mask = new Uint8Array(W * H);
    for (let y = b.y; y < b.y + b.h; y++) mask.fill(1, y * W + b.x, y * W + b.x + b.w);
    const hull = [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
    ];
    addBody(hull, b, false, mask);
    // A thin edge, so a piece of plain paper is still seen falling over the paper behind it.
    const piece = sprites[sprites.length - 1]?.image;
    const pctx = piece?.getContext('2d');
    if (piece && pctx) {
      pctx.strokeStyle = 'rgba(60, 60, 60, 0.45)';
      pctx.lineWidth = Math.max(2, Math.round(Math.min(W, H) / 240));
      pctx.strokeRect(pctx.lineWidth / 2, pctx.lineWidth / 2, piece.width - pctx.lineWidth, piece.height - pctx.lineWidth);
    }
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
