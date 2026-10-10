// Projectile: a cannon (or an arrow) launches the drawn ball along a parabola, leaving a dotted trail.
// Lands, waits 1.5 s, and fires again — the scene never stands still.

import Matter from 'matter-js';
import type { Contour, Point, SceneBuilder, SceneInput, Sprite } from '../types';
import { contourMask, cutSprite, eraseFromPaper, maskBounds, roleOf } from './common';
import { STEP_ACCEL, STEP_MS } from '../sim';

/** params.speed is read relative to this value (speed 10 = the auto-fitted launch speed). */
const DEFAULT_SPEED = 10;
const RELAUNCH_MS = 1500;
const MIN_ELEV_DEG = 10;
const MAX_ELEV_DEG = 80;
const DEFAULT_ELEV_DEG = 45;
const TRAIL_EVERY = 2; // steps between trail samples

interface Axis {
  centroid: Point;
  /** Unit vector of the long axis. */
  dir: Point;
  /** Extreme projections of the ink along dir (min < 0 < max). */
  min: number;
  max: number;
  /** Long/short spread ratio; ~1 means no clear direction. */
  elongation: number;
  pixels: Point[];
}

/** Principal axis of the ink pixels inside the given contours' mask. */
function inkAxis(input: SceneInput, contours: Contour[]): Axis | null {
  const { width: W, height: H } = input;
  const mask = contourMask(input, contours, 2);
  const b = maskBounds(mask, W, H);
  if (!b) return null;
  const pixels: Point[] = [];
  // Prefer actual ink; fall back to the filled mask if the ink mask is empty there.
  for (const useInk of [true, false]) {
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = y * W + x;
        if (mask[i] && (!useInk || input.ink[i])) pixels.push({ x, y });
      }
    if (pixels.length >= 10) break;
  }
  if (pixels.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of pixels) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pixels.length;
  cy /= pixels.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pixels) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dir = { x: Math.cos(theta), y: Math.sin(theta) };
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  let min = Infinity, max = -Infinity;
  for (const p of pixels) {
    const t = (p.x - cx) * dir.x + (p.y - cy) * dir.y;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return { centroid: { x: cx, y: cy }, dir, min, max, elongation: Math.sqrt(l1 / l2), pixels };
}

/** Arrow: the head end is the one whose ink spreads widest across the shaft (the barbs). */
function arrowDirection(ax: Axis): Point {
  const len = ax.max - ax.min;
  const zone = len * 0.3;
  let spreadMin = 0, spreadMax = 0;
  for (const p of ax.pixels) {
    const dx = p.x - ax.centroid.x, dy = p.y - ax.centroid.y;
    const t = dx * ax.dir.x + dy * ax.dir.y;
    const n = Math.abs(-dx * ax.dir.y + dy * ax.dir.x);
    if (t > ax.max - zone) spreadMax = Math.max(spreadMax, n);
    if (t < ax.min + zone) spreadMin = Math.max(spreadMin, n);
  }
  if (Math.abs(spreadMax - spreadMin) < 1) return upward(ax.dir); // can't tell: assume it points up-ish
  return spreadMax >= spreadMin ? ax.dir : { x: -ax.dir.x, y: -ax.dir.y };
}

/** Pick the sign of an axis that points up (screen y decreases); near-horizontal -> rightwards. */
function upward(d: Point): Point {
  if (Math.abs(d.y) < 0.1) return d.x >= 0 ? d : { x: -d.x, y: -d.y };
  return d.y < 0 ? d : { x: -d.x, y: -d.y };
}

/** Keep the launch between MIN and MAX elevation so there is always a visible arc. */
function clampElevation(d: Point): number {
  const right = d.x >= 0;
  let elev = (Math.atan2(-d.y, Math.abs(d.x)) * 180) / Math.PI;
  if (!Number.isFinite(elev)) elev = DEFAULT_ELEV_DEG;
  elev = Math.min(MAX_ELEV_DEG, Math.max(MIN_ELEV_DEG, elev));
  const rad = (elev * Math.PI) / 180;
  return right ? -rad : Math.PI + rad; // screen-space angle of the velocity
}

/** A small marker-drawn ball for when no projectile was drawn. */
function drawnBall(r: number): HTMLCanvasElement {
  const pad = Math.ceil(r * 0.4) + 2;
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(2 * (r + pad));
  const ctx = c.getContext('2d')!;
  const cx = c.width / 2, cy = c.height / 2;
  const wobble = (seed: number, rr: number) => {
    ctx.beginPath();
    const n = 28;
    for (let i = 0; i <= n + 2; i++) {
      const a = (i / n) * Math.PI * 2 + seed;
      const k = rr * (1 + 0.06 * Math.sin(a * 3 + seed * 5) + 0.03 * Math.sin(a * 7 + seed));
      const x = cx + Math.cos(a) * k, y = cy + Math.sin(a) * k;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
  };
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.fillStyle = 'rgba(28,28,32,0.82)';
  wobble(0.7, r * 0.92);
  ctx.fill();
  ctx.strokeStyle = '#1c1c20';
  ctx.lineWidth = Math.max(2, r * 0.2);
  wobble(1.9, r * 0.95);
  ctx.stroke();
  return c;
}

export const buildProjectile: SceneBuilder = (input) => {
  const { width: W, height: H } = input;
  const byRole = (...roles: string[]) =>
    input.contours.filter((c) => {
      const r = roleOf(input, c.id);
      return !!r && roles.includes(r.role);
    });

  const balls = byRole('projectile');
  const grounds = byRole('ground', 'incline');
  const cannons = byRole('cannon');
  const arrows = byRole('arrow');

  // --- Launch direction and the point the ball leaves from ---
  let dir: Point | null = null;
  let launch: Point | null = null;
  if (arrows.length) {
    const ax = inkAxis(input, [arrows.reduce((a, b) => (b.area + b.inkPixels > a.area + a.inkPixels ? b : a))]);
    if (ax && ax.elongation > 1.5) {
      dir = arrowDirection(ax);
      const tail = dir.x * ax.dir.x + dir.y * ax.dir.y > 0 ? ax.min : ax.max; // opposite end to the head
      launch = { x: ax.centroid.x + ax.dir.x * tail, y: ax.centroid.y + ax.dir.y * tail };
    }
  }
  if (!dir) {
    // Cannon: barrel = the most elongated cannon part; if none was labelled, any non-ball, non-ground drawing.
    const pool = cannons.length
      ? cannons
      : input.contours.filter((c) => !balls.includes(c) && !grounds.includes(c) && !arrows.includes(c));
    let best: Axis | null = null;
    for (const c of pool) {
      const ax = inkAxis(input, [c]);
      if (ax && (!best || ax.elongation > best.elongation)) best = ax;
    }
    if (best) {
      if (best.elongation > 1.4) dir = upward(best.dir);
      const d = dir ?? { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
      // Muzzle = farthest ink along the firing direction.
      let far = -Infinity;
      let muzzle = best.centroid;
      for (const p of best.pixels) {
        const t = (p.x - best.centroid.x) * d.x + (p.y - best.centroid.y) * d.y;
        if (t > far) {
          far = t;
          muzzle = p;
        }
      }
      launch = muzzle;
    }
  }
  const angle = clampElevation(dir ?? { x: Math.SQRT1_2, y: -Math.SQRT1_2 });
  const unit = { x: Math.cos(angle), y: Math.sin(angle) };

  // --- The ball: the drawn one if present, otherwise a marker-style dot at the muzzle ---
  const masks: Uint8Array[] = [];
  let r: number;
  let start: Point;
  let image: HTMLCanvasElement;
  let offset: Point;
  const ballMask = balls.length ? contourMask(input, balls) : null;
  const ballBounds = ballMask ? maskBounds(ballMask, W, H) : null;
  if (ballMask && ballBounds) {
    r = Math.max(6, (Math.max(ballBounds.w, ballBounds.h) / 2) * 0.9);
    start = { x: ballBounds.x + ballBounds.w / 2, y: ballBounds.y + ballBounds.h / 2 };
    ({ image, offset } = cutSprite(input, ballMask));
    masks.push(ballMask);
  } else {
    r = Math.max(8, Math.round(Math.min(W, H) * 0.022));
    const from = launch ?? { x: W * 0.15, y: H * 0.7 };
    start = {
      x: Math.min(W - r, Math.max(r, from.x + unit.x * r)),
      y: Math.min(H - r, Math.max(r, from.y + unit.y * r)),
    };
    image = drawnBall(r);
    offset = { x: start.x - image.width / 2, y: start.y - image.height / 2 };
  }

  // --- Floor: the drawn ground line, else the bottom edge of the photo ---
  let floorY = H;
  if (grounds.length) {
    const g = grounds.reduce((a, b) => (b.bbox.w > a.bbox.w ? b : a));
    floorY = g.bbox.h < g.bbox.w * 0.3 ? g.bbox.y + g.bbox.h / 2 : g.bbox.y;
  }
  if (floorY < start.y + r + 2) floorY = H;
  if (floorY < start.y + r + 2) floorY = start.y + r + 2;
  const floor = Matter.Bodies.rectangle(W / 2, floorY + 50, W * 4, 100, { isStatic: true, friction: 0.9 });

  // --- Launch speed: fitted so the arc lands inside the picture, scaled by params.speed ---
  const g = STEP_ACCEL * ((input.analysis.params.gravity || 9.8) / 9.8);
  const space = unit.x >= 0 ? W - start.x : start.x;
  const range = Math.min(W * 0.9, Math.max(W * 0.25, space * 0.85));
  const sin2 = Math.max(Math.sin((2 * MIN_ELEV_DEG * Math.PI) / 180), Math.abs(Math.sin(2 * angle)));
  let speed = Math.sqrt((range * g) / sin2);
  const headroom = start.y - r - 4; // keep the apex on screen
  const vUp = -unit.y * speed;
  if (vUp > 0 && (vUp * vUp) / (2 * g) > headroom) speed = Math.max(speed * 0.5, Math.sqrt(2 * g * Math.max(0, headroom)) / -unit.y);
  const userSpeed = input.analysis.params.speed;
  if (typeof userSpeed === 'number' && userSpeed > 0) speed *= userSpeed / DEFAULT_SPEED;
  const v0 = { x: unit.x * speed, y: unit.y * speed };

  const ball = Matter.Bodies.circle(start.x, start.y, r, {
    friction: 0.9,
    frictionAir: 0,
    restitution: 0.15,
    density: 0.002,
  });
  Matter.Body.setVelocity(ball, v0);

  // --- Loop: fly, land, wait 1.5 s, fire again. Keep the previous arc as a faint ghost. ---
  let trail: Point[] = [{ ...start }];
  let ghost: Point[] = [];
  let steps = 0;
  let landedSteps = -1;
  const relaunchSteps = Math.round(RELAUNCH_MS / STEP_MS);

  const onStep = () => {
    steps++;
    const p = ball.position;
    if (landedSteps < 0) {
      if (steps % TRAIL_EVERY === 0) trail.push({ x: p.x, y: p.y });
      const onFloor = p.y + r >= floorY - 1.5 && ball.velocity.y > -0.5 && steps > 5;
      const gone = p.x < -4 * r || p.x > W + 4 * r || p.y > H + 4 * r;
      if (onFloor || gone) {
        trail.push({ x: p.x, y: p.y });
        landedSteps = 0;
      }
      return;
    }
    if (++landedSteps < relaunchSteps) return;
    ghost = trail;
    trail = [{ ...start }];
    steps = 0;
    landedSteps = -1;
    Matter.Body.setPosition(ball, start);
    Matter.Body.setAngle(ball, 0);
    Matter.Body.setAngularVelocity(ball, 0);
    Matter.Body.setVelocity(ball, v0);
  };

  const lw = Math.max(2, Math.min(W, H) / 220);
  const strokePath = (ctx: CanvasRenderingContext2D, pts: Point[]) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.stroke();
  };
  const onDraw = (ctx: CanvasRenderingContext2D) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.setLineDash([lw * 0.1, lw * 3]);
    ctx.strokeStyle = 'rgba(37,99,235,0.25)';
    strokePath(ctx, ghost);
    ctx.strokeStyle = 'rgba(37,99,235,0.9)';
    strokePath(ctx, trail.concat(landedSteps < 0 ? [{ x: ball.position.x, y: ball.position.y }] : []));
  };

  const sprite: Sprite = {
    image,
    offset,
    follow: { kind: 'body', body: ball, origin: { ...start }, originAngle: 0 },
  };

  return {
    bodies: [ball, floor],
    constraints: [],
    sprites: [sprite],
    background: eraseFromPaper(input, masks),
    label: 'Projectile',
    onStep,
    onDraw,
  };
};
