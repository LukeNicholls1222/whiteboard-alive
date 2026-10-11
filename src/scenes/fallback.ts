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
import type { CleanPart, Contour, Point, SceneBuilder, Sprite } from '../types';
import { contourMask, cutSprite, eraseFromPaper, roleOf } from './common';
import { replayWhenStopped } from './replay';
import { linePatch, type Patch } from './blank-patch';
import { STEP_ACCEL, STEP_MS } from '../sim';
import { BASE_SCALE, DEFAULT_SCALE, scaleOf } from '../units';
import { fallPxPerMeter } from '../defaults';
import { fmt, inkSegment, offAxis, TIDY, TIDY_MAX_DEG, tidyLog, untidyMatters, untidyTurn } from './tidy';

/** A body whose bottom is closer than this (× view height) to the floor hops first. */
const MIN_DROP = 0.25;
/** Hop height (× view height), limited by the room above the drawing. */
const HOP = 0.2;
/** Initial spin, rad per step. */
const SPIN = 0.025;

/** A stroke this long (× the picture's width) and thin, with no role, is the ground the objects fall onto. */
const GROUND_MIN_W = 0.4;

/** A contour's hull as a line: its length (farthest two corners) and width across that. Null unless it runs level-ish. */
function lineShape(c: Contour): { long: number; across: number } | null {
  const vs = c.hull;
  if (vs.length < 2) return null;
  let a = vs[0], b = vs[0], far = -1;
  for (const p of vs) for (const q of vs) {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d > far) [far, a, b] = [d, p, q];
  }
  const v = { x: b.x - a.x, y: b.y - a.y };
  const L = Math.hypot(v.x, v.y) || 1;
  const across = Math.max(1, ...vs.map((p) => Math.abs((p.x - a.x) * v.y - (p.y - a.y) * v.x) / L));
  if (offAxis(v).axis !== 'h') return null;
  return { long: L, across };
}

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
 * The part of a photo nobody found lines in that falls: its most line-like marks (thin, with paper on both sides; a
 * phone / hand shadow is never picked however dark it is), or the middle of plain paper. See blank-patch.ts.
 */
function blankPatch(photo: HTMLCanvasElement): Patch {
  const W = photo.width, H = photo.height;
  const d = photo.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const luma = new Uint8Array(W * H);
  for (let i = 0; i < luma.length; i++) luma[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  const debug = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
  return linePatch(luma, W, H, debug ? (msg) => console.log(`[fallback] no lines found: ${msg}`) : undefined);
}

export const buildFallback: SceneBuilder = (input) => {
  const { width: W, height: H } = input;
  const bodies: Matter.Body[] = [];
  const sprites: Sprite[] = [];
  const masks: Uint8Array[] = [];
  const moving: Matter.Body[] = [];
  /** Static bodies made from the drawing (a drawn ground or ramp): shown in the clean figure, unlike the walls. */
  const drawnStatic: Matter.Body[] = [];

  // A drawn ground line (a long thin stroke, mostly level: the AI's ground, or with no role at all one across at least
  // GROUND_MIN_W of the picture) stays fixed and the objects land on it. Its body is a thick slab under the line, so a
  // fast fall cannot pass through it. Tidy-up (tidy.ts): within TIDY_MAX_DEG of level it is made level, the body as well
  // as the picture (a ground line at the level height, traced where it was drawn by the morph); steeper ones stay as drawn.
  const tidyNotes: string[] = [];
  /** Drawn outline of each ground line body. */
  const drawnPoints = new Map<Matter.Body, Point[]>();
  /** Levelled ground lines: the clean figure draws each as a ground line from x0 to x1. */
  const levelLines = new Map<Matter.Body, CleanPart>();
  /** Top of every drawn ground line (slab) at x, null past its ends: where a body above it lands. */
  const groundTops: ((x: number) => number | null)[] = [];
  const isStaticRole = (c: Contour) => {
    const r = roleOf(input, c.id);
    return !!r && (r.role === 'ground' || r.role === 'incline');
  };
  const groundLine = new Set<Contour>();
  for (const c of input.contours) {
    const role = roleOf(input, c.id)?.role;
    const shape = lineShape(c);
    if (!shape) continue;
    const fixedRole = role === 'ground' || role === 'incline';
    if (fixedRole ? shape.long >= 4 * shape.across : (!role || role === 'other' || role === 'label') && shape.long >= GROUND_MIN_W * W && shape.long >= 6 * shape.across)
      groundLine.add(c);
  }
  // Only lines drawn: they fall as before (something always moves).
  const outlines = input.contours.filter((c) => c.hull.length >= 3);
  if (outlines.length && outlines.every((c) => groundLine.has(c) || isStaticRole(c)))
    for (const c of [...groundLine]) if (!isStaticRole(c)) groundLine.delete(c);

  const addGroundLine = (c: Contour) => {
    const inLine = contourMask(input, [c], 3);
    const b = c.bbox;
    const seg = inkSegment(input.ink, W, H, { x0: b.x - 3, y0: b.y - 3, x1: b.x + b.w + 3, y1: b.y + b.h + 3 }, (i) => inLine[i] === 1);
    if (!seg) return false;
    const L = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
    const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
    const turn = Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x);
    const depth = Math.max(40, 0.05 * H);
    const opts = { isStatic: true, friction: 0.6, restitution: 0.3 };
    const level = TIDY && Math.abs(seg.deg) <= TIDY_MAX_DEG;
    tidyNotes.push(`ground ${fmt(seg.deg)} → ${level ? '0°' : `${fmt(seg.deg)} (kept${TIDY ? ': slanted on purpose' : ''})`}`);
    let body: Matter.Body;
    if (level) {
      // Level at the height of its middle: the top of the slab is the line.
      body = Matter.Bodies.rectangle(mid.x, mid.y + depth / 2, L, depth, opts);
      const part: CleanPart = { kind: 'ground', y: mid.y, x0: mid.x - L / 2, x1: mid.x + L / 2 };
      const u = untidyTurn(mid, turn);
      if (untidyMatters(u, L / 2)) part.untidy = u;
      levelLines.set(body, part);
      groundTops.push((x) => (x >= mid.x - L / 2 && x <= mid.x + L / 2 ? mid.y : null));
    } else {
      // As drawn: the top of the slab along the top of the stroke.
      const n = { x: -Math.sin(turn), y: Math.cos(turn) };
      const k = depth / 2 - seg.thick / 2;
      body = Matter.Bodies.rectangle(mid.x + n.x * k, mid.y + n.y * k, L, depth, { ...opts, angle: turn });
      const top = (x: number) => mid.y - seg.thick / 2 / Math.cos(turn) + (x - mid.x) * Math.tan(turn);
      groundTops.push((x) => (x >= seg.a.x && x <= seg.b.x ? top(x) : null));
    }
    bodies.push(body);
    drawnStatic.push(body);
    drawnPoints.set(body, c.hull.map((p) => ({ ...p })));
    return true;
  };

  const addBody = (hull: { x: number; y: number }[], bbox: { x: number; y: number }, isStatic: boolean, mask: Uint8Array | null) => {
    const body = Matter.Bodies.fromVertices(0, 0, [hull], { isStatic, friction: 0.4, restitution: 0.3 });
    if (!body) return;
    // fromVertices recentres on the centre of mass; move it back over the drawing.
    const hb = body.bounds;
    Matter.Body.translate(body, { x: bbox.x - hb.min.x, y: bbox.y - hb.min.y });
    bodies.push(body);
    if (isStatic) drawnStatic.push(body);
    if (isStatic || !mask) return;
    moving.push(body);
    masks.push(mask);
    sprites.push({
      ...cutSprite(input, mask),
      follow: { kind: 'body', body, origin: { ...body.position }, originAngle: body.angle },
    });
  };

  const isStaticContour = (c: Contour) => isStaticRole(c) || groundLine.has(c);
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
    if (groundLine.has(c) && addGroundLine(c)) continue;
    const group = input.contours.filter((k) => rootOf(k) === c);
    addBody(c.hull, c.bbox, isStatic, isStatic ? null : contourMask(input, group));
  }

  // No lines found at all (faint pencil, an odd photo, blank paper): the most line-like marks of the photo (never a
  // shadow), or its middle, fall as one block, so the screen never stays still.
  if (!input.contours.length) {
    const b = blankPatch(input.paper);
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

  // A body drawn overlapping a ground line (or reached by the levelled line) starts just on top of it.
  const groundBodies = [...drawnPoints.keys()];
  for (const body of moving)
    for (let lift = 0; lift < 0.2 * H && Matter.Query.collides(body, groundBodies).length; lift++) Matter.Body.translate(body, { x: 0, y: -1 });
  /** Where a body above x comes down: the highest ground line under its bottom, else the floor. */
  const supportAt = (x: number, bottom: number) => {
    let best = floorTop;
    for (const top of groundTops) {
      const y = top(x);
      if (y !== null && y >= bottom - 2 && y < best) best = y;
    }
    return best;
  };

  moving.forEach((body, i) => {
    const b = body.bounds;
    // If it is resting below the floor line already (drawn to the very bottom), lift it onto the floor.
    if (b.max.y > floorTop) Matter.Body.translate(body, { x: 0, y: floorTop - b.max.y });
    const gap = supportAt((b.min.x + b.max.x) / 2, body.bounds.max.y) - body.bounds.max.y;
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
  // Default size (defaults.ts): how long the run lasts, from the start until everything has stopped (falling, tipping
  // over and sliding depend on the shapes, so it is played once on a scratch engine), and how long the slowest body
  // takes to come down (y = vy·t + g t²/2 to what it lands on).
  const landSteps = Math.max(0, ...moving.map((b) => {
    const gap = Math.max(0, supportAt((b.bounds.min.x + b.bounds.max.x) / 2, b.bounds.max.y) - b.bounds.max.y);
    const vy = b.velocity.y;
    return (-vy + Math.sqrt(vy * vy + 2 * STEP_ACCEL * gap)) / STEP_ACCEL;
  }));
  const runSteps = stepsUntilStopped(bodies, moving);

  // Clean figure: the floor line, drawn static parts as fixed solids, and every falling body as its own physics outline
  // (corners slightly rounded). With no lines found at all, the photo's patch itself keeps falling.
  const clean: CleanPart[] = [{ kind: 'ground', y: floorTop }];
  for (const b of drawnStatic) {
    const line = levelLines.get(b);
    if (line) clean.push(line);
    // A ground line kept as drawn shows its drawn outline; other fixed parts their own shape.
    else clean.push({ kind: 'solid', points: (drawnPoints.get(b) ?? b.vertices).map((v) => ({ x: v.x, y: v.y })) });
  }
  tidyLog('Falling objects', tidyNotes);
  if (!input.contours.length) for (const sprite of sprites) clean.push({ kind: 'sprite', sprite });
  else for (const body of moving) clean.push({ kind: 'body', body, tone: 'mass' });

  const scene: ReturnType<SceneBuilder> = {
    bodies,
    constraints: [],
    sprites,
    clean,
    background: eraseFromPaper(input, masks),
    label: 'Falling objects',
    defaultPxPerMeter: fallPxPerMeter(runSteps < MAX_PROBE_STEPS ? runSteps : null, landSteps),
    onStep: replayWhenStopped(moving, () => scaleOf(scene).timeFactor),
    // Fastest on hitting the floor: v² = v₀² + 2g·(drop height), the highest of all the falling bodies.
    speedHint: Math.max(0, ...moving.map((b) => Math.sqrt(b.velocity.x ** 2 + b.velocity.y ** 2 + 2 * STEP_ACCEL * ((input.analysis.params.gravity || 9.8) / 9.8) * Math.max(0, floorTop - b.bounds.max.y)))),
  };
  return scene;
};

/** Longest run the scratch engine plays (25 s of engine time). */
const MAX_PROBE_STEPS = 1500;
/** A body that moves less than this in a step (any point of it, px) is at rest. */
const STILL_PX = 0.05;

/**
 * Steps from the start until every moving body has stopped (the last step anything moved before replay.ts holds the
 * still picture), played on a scratch engine at Earth gravity; then every body is put back exactly as it was.
 * MAX_PROBE_STEPS when it never stops.
 */
function stepsUntilStopped(bodies: Matter.Body[], moving: Matter.Body[]): number {
  if (!moving.length) return 0;
  const saved = moving.map((b) => ({ b, position: { ...b.position }, angle: b.angle, velocity: { ...b.velocity }, spin: b.angularVelocity }));
  const engine = Matter.Engine.create();
  engine.gravity.scale = BASE_SCALE;
  Matter.Composite.add(engine.world, bodies);
  // The scene's own replay hook decides when it is held still (its settling damps a body rocking in place).
  const probe = replayWhenStopped(moving, () => DEFAULT_SCALE.timeFactor);
  let steps = MAX_PROBE_STEPS;
  /** Last step on which some point of a body still moved visibly. */
  let lastMove = 0;
  let prev = moving.map((b) => ({ x: b.position.x, y: b.position.y, a: b.angle }));
  for (let i = 1; i <= MAX_PROBE_STEPS; i++) {
    Matter.Engine.update(engine, STEP_MS);
    probe(engine);
    if (moving.every((b) => b.velocity.x === 0 && b.velocity.y === 0 && b.angularVelocity === 0)) {
      // Held still by the replay: it had stopped when it last moved.
      steps = Math.max(1, lastMove);
      break;
    }
    const now = moving.map((b) => ({ x: b.position.x, y: b.position.y, a: b.angle }));
    const moved = moving.some((b, k) => {
      const size = Math.max(b.bounds.max.x - b.bounds.min.x, b.bounds.max.y - b.bounds.min.y);
      return Math.hypot(now[k].x - prev[k].x, now[k].y - prev[k].y) + (Math.abs(now[k].a - prev[k].a) * size) / 2 > STILL_PX;
    });
    if (moved) lastMove = i;
    prev = now;
  }
  Matter.Composite.clear(engine.world, false);
  Matter.Engine.clear(engine);
  for (const s of saved) {
    Matter.Body.setPosition(s.b, s.position);
    Matter.Body.setAngle(s.b, s.angle);
    Matter.Body.setVelocity(s.b, s.velocity);
    Matter.Body.setAngularVelocity(s.b, s.spin);
    const cache = s.b as unknown as { positionImpulse: Matter.Vector; constraintImpulse: Matter.Vector & { angle: number } };
    cache.positionImpulse.x = cache.positionImpulse.y = 0;
    cache.constraintImpulse.x = cache.constraintImpulse.y = cache.constraintImpulse.angle = 0;
  }
  return steps;
}
