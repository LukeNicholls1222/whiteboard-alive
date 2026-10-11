// Pendulum: the drawn string and bob swing rigidly around the pivot, exactly as drawn.
//
// Physics: a rigid pendulum has one degree of freedom, the string angle θ. Matter's position-based rope
// constraint bled about a fifth of the swing every 10 s (numerical damping), so like the pulley scene we
// integrate the equation of motion ourselves every step,
//   θ'' = −(g/L)·sin θ − k·θ'·|θ'|      (θ = 0 straight down),
// with RK4 in a few substeps, and put the bob body exactly there with its true velocity (the velocity
// arrows, the energy graph and the period readout all read the body). g is read from the engine every
// step, so the gravity slider, voice and Moon mode apply at once. With k = 0 the swing never dies out.
//
// Air drag on the bob, F = c·v² with c = ½ρ·Cd·A (air.ts) and v = L·θ', gives θ'' = −(c·L/m)·θ'·|θ'|, so the
// dimensionless k = params.airDrag × c·L/m (airDrag = factor on real air, 0 = off). k does not depend on the
// time unit, so the slow-motion factor needs no conversion.
//
// View: the picture always holds the whole swing (pendulum-view.ts) - a bob drawn near the edge or a swing that grows
// on the Moon zooms the picture out, in the photo's own shape, instead of leaving the picture.

import Matter from 'matter-js';
import type { CleanPart, Point, SceneBuilder } from '../types';
import { contourMask, cutSprite, deepestPoint, eraseFromPaper, roleOf } from './common';
import { MAX_VIEW_ASPECT, MIN_VIEW_ASPECT, STEP_ACCEL, STEP_MS } from '../sim';
import { DEFAULT_KG, noteFor, scaleFor } from '../units';
import { dragConstant, roundFactor } from '../air';
import { drawnSupport, fmt, TIDY, tidyLog, untidyMatters, untidySegment, untidyTurn } from './tidy';
import { pendulumTarget, SmoothView, swingAmplitude, swingBox, unionRect } from './pendulum-view';
import { pictureRoom } from './picture-room';

const KICK_DEG = 20;
/** Drag k the air switch aims for: about 10 % off a 20° swing per period, the swing visibly dies down in ~30 s. */
const AIR_K_TARGET = 0.12;
/** RK4 substeps per physics step. */
const SUBSTEPS = 4;

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

  const { pivot, entry } = traceString(all, W, H, bob, bobRadius);

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
  // onStep puts the bob on the exact pendulum path every step; there is nothing for it to collide with.
  const body = Matter.Bodies.circle(bob.x, bob.y, bobRadius, {
    frictionAir: 0,
    friction: 0,
    restitution: 0,
    collisionFilter: { group: -1, category: 0, mask: 0 },
  });

  // θ = string angle from straight down (positive = bob right of the pivot), ω = dθ/dt in rad per step.
  let theta = Math.atan2(bob.x - pivot.x, bob.y - pivot.y);
  let omega = 0;
  // Never show a still pendulum: if it hangs straight down, give it ~KICK_DEG of swing.
  if (Math.abs(theta) < (8 * Math.PI) / 180)
    omega = Math.sqrt(2 * STEP_ACCEL * length * (1 - Math.cos((KICK_DEG * Math.PI) / 180))) / length;

  const place = () => {
    const s = Math.sin(theta), c = Math.cos(theta);
    Matter.Body.setPosition(body, { x: pivot.x + length * s, y: pivot.y + length * c });
    // Velocity along the swing, L·ω, in px per step like every Matter velocity.
    Matter.Body.setVelocity(body, { x: length * omega * c, y: -length * omega * s });
  };
  place();

  const params = input.analysis.params;
  const kg = noteFor(input.analysis, 'mass', ['bob', 'block', 'ball'])?.value;
  // Real air on this bob: k = c·L/m with the drawn radius and string length in metres (same scale buildScene sets).
  const ppm = scaleFor(input, { string: length }).pxPerMeter;
  const kReal = (dragConstant(bobRadius / ppm) * (length / ppm)) / (kg ?? DEFAULT_KG);
  const airFactor = roundFactor(AIR_K_TARGET / Math.max(1e-12, kReal));
  // Gravity the swing runs under right now (px per step², downward), for the view; the engine's once it steps.
  let gNow = STEP_ACCEL * ((params.gravity || 9.8) / 9.8);
  const onStep = (engine: Matter.Engine) => {
    // Engine gravity (slider / voice / Moon mode) in px per step².
    const toStep = engine.gravity.scale * STEP_MS * STEP_MS;
    const gx = engine.gravity.x * toStep, gy = engine.gravity.y * toStep;
    gNow = gy;
    // Air drag (read live; airDrag = factor on real air, 0 = none): θ'' gets −k·θ'·|θ'|. k = 0.1 takes ~9 % off a 20° swing per period.
    const k = Math.max(0, Number(params.airDrag) || 0) * kReal;
    // Tangential gravity over L (the tangent is (cos θ, −sin θ)), minus drag.
    const acc = (th: number, om: number) => (gx * Math.cos(th) - gy * Math.sin(th)) / length - k * om * Math.abs(om);
    const h = 1 / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      const a1 = acc(theta, omega);
      const t2 = omega + 0.5 * h * a1, a2 = acc(theta + 0.5 * h * omega, t2);
      const t3 = omega + 0.5 * h * a2, a3 = acc(theta + 0.5 * h * t2, t3);
      const t4 = omega + h * a3, a4 = acc(theta + h * t3, t4);
      theta += (h / 6) * (omega + 2 * t2 + 2 * t3 + t4);
      omega += (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
    }
    // Keep θ in −π..π if it ever goes over the top (no gravity, huge swings).
    if (Math.abs(theta) > Math.PI) theta -= 2 * Math.PI * Math.round(theta / (2 * Math.PI));
    place();
  };

  // Clean figure: a hatched ceiling through the pivot, the string from the pivot to the bob's centre, the bob as the
  // physics circle.
  const ceilHalf = Math.max(2.2 * bobRadius, Math.min(0.3 * length, 0.2 * W), 30);
  // Tidy-up (tidy.ts): a ceiling drawn within 15° of level is level (steeper stays as drawn); the string meets the
  // bob's centre (it always did in the physics; the drawn string may aim a little off it). The swing angle is the
  // physics and is never changed.
  const tidyNotes: string[] = [];
  const ceiling = drawnSupport(input.ink, W, H, pivot, 'h', ceilHalf, Math.max(10, 0.6 * bobRadius), (i) => !swing[i]);
  // ?tidy=0: level, as before the tidy-up.
  const ceilDeg = TIDY && ceiling ? ceiling.used : 0;
  const ceilRad = (ceilDeg * Math.PI) / 180;
  const cu = { x: Math.cos(ceilRad), y: Math.sin(ceilRad) };
  const support: CleanPart = {
    kind: 'support',
    from: { x: pivot.x - cu.x * ceilHalf, y: pivot.y - cu.y * ceilHalf },
    to: { x: pivot.x + cu.x * ceilHalf, y: pivot.y + cu.y * ceilHalf },
    side: { x: cu.y, y: -cu.x },
  };
  if (ceiling) {
    tidyNotes.push(`ceiling ${fmt(ceiling.drawn)} → ${fmt(ceilDeg)}${ceilDeg !== 0 ? ' (kept: slanted on purpose)' : ''}`);
    const turn = untidyTurn(pivot, ((ceiling.drawn - ceilDeg) * Math.PI) / 180);
    if (TIDY && untidyMatters(turn, ceilHalf)) support.untidy = turn;
  }
  const rope: CleanPart = { kind: 'rope', from: () => pivot, to: () => body.position };
  const entryLen = Math.hypot(entry.x - pivot.x, entry.y - pivot.y);
  if (entryLen > 1) {
    // The drawn string: from the pivot towards where it meets the bob's outline.
    const off = Math.abs((entry.x - pivot.x) * (bob.y - pivot.y) - (entry.y - pivot.y) * (bob.x - pivot.x)) / entryLen;
    tidyNotes.push(`string offset ${off.toFixed(1)}px → centre`);
    const drawnEnd = { x: pivot.x + ((entry.x - pivot.x) / entryLen) * length, y: pivot.y + ((entry.y - pivot.y) / entryLen) * length };
    const seg = untidySegment(pivot, { ...body.position }, pivot, drawnEnd);
    if (TIDY && untidyMatters(seg, length)) rope.untidy = seg;
  }
  tidyLog('Pendulum', tidyNotes);
  const clean: CleanPart[] = [support, rope, { kind: 'pin', at: () => pivot }, { kind: 'ball', body, radius: bobRadius, tone: 'mass' }];

  // View (pendulum-view.ts): the whole swing, from its range (energy now, gravity now), never from the bob's place;
  // the photo while that fits with room (CSS px) from the edges and the buttons over its top, else zoomed out in
  // the photo's shape with the swing in the middle, eased so a gravity change glides.
  const geo = { pivot, length, bobRadius };
  const hatch = 12;
  const supportBox = unionRect(
    { x: support.from.x - hatch, y: support.from.y - hatch, w: 2 * hatch, h: 2 * hatch },
    { x: support.to.x - hatch, y: support.to.y - hatch, w: 2 * hatch, h: 2 * hatch },
  );
  const smooth = new SmoothView(W, H);
  const bounds = { min: MIN_VIEW_ASPECT, max: MAX_VIEW_ASPECT };
  const view = () => {
    const box = unionRect(swingBox(geo, swingAmplitude(length, theta, omega, gNow)), supportBox);
    const { cssW, insets } = pictureRoom();
    const target = pendulumTarget({ photoW: W, photoH: H, cssW, insets, bounds }, box);
    return smooth.read(target, performance.now() / 1000);
  };

  return {
    bodies: [body],
    constraints: [],
    clean,
    sprites: [
      {
        ...cutSprite(input, swing),
        follow: { kind: 'swing', pivot, body, originAngle: Math.atan2(bob.y - pivot.y, bob.x - pivot.x), originLength: length },
      },
    ],
    background: eraseFromPaper(input, [swing]),
    label: 'Pendulum',
    view,
    onStep,
    // L in 2π√(L/g) is pivot to bob centre.
    measures: { string: length },
    parts: {
      string: { at: () => ({ x: (pivot.x + body.position.x) / 2, y: (pivot.y + body.position.y) / 2 }) },
      bob: { at: () => body.position, clear: bobRadius, body, kg: kg ?? DEFAULT_KG, kgFrom: kg ? 'input' : 'assumed' },
    },
    physics: { airDrag: airFactor },
    // Fastest at the bottom of the swing: v² = (L·ω₀)² + 2gL(1 − cos θ₀) (evaluated now, from the starting state).
    speedHint: Math.hypot(length * omega, Math.sqrt(2 * STEP_ACCEL * ((params.gravity || 9.8) / 9.8) * length * (1 - Math.cos(theta)))),
  };
};

/**
 * Walk from the bob up along the string. Stops where the ink ends (free pivot point)
 * or where the line suddenly widens (it hit the ceiling). Returns the pivot.
 */
function traceString(mask: Uint8Array, W: number, H: number, bob: Point, r: number): { pivot: Point; entry: Point } {
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
  // Where the drawn string leaves the bob: the centre of its ink in the ring above the bob.
  const entry = { ...p };
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
  if (Math.hypot(last.x - bob.x, last.y - bob.y) < r * 2) return { pivot: { x: bob.x, y: Math.max(0, bob.y - 4 * r) }, entry };
  return { pivot: last, entry };
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
