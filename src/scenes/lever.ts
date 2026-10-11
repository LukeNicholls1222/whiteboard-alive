// Seesaw / lever: a plank lying on a triangle's tip, a weight on each side. The side with the larger moment m·g·d goes
// down until the plank's end reaches the floor (the triangle's base), bounces a little, rests, and the scene replays.
// m₁d₁ = m₂d₂ with every value typed in: it does not tip; it rocks gently and settles level ("Balanced!"). Within the
// drawing's error (sizes estimated from the drawing): it tips a little toward the heavier side and stops ("Nearly balanced").
//
// Geometry comes only from the ink (lever-plan.ts): pivot = where the plank touches the tip, plank ends and thickness,
// weights = the strokes resting on the plank, left / right of the pivot. Masses ∝ drawn area (lighter = 1 kg), the
// distance d of each weight = how far its centre is from the pivot along the plank. "Your numbers" can set Left / Right
// mass (kg) and Left / Right distance (m; the weight slides along the plank to it).
//
// Physics: one rigid body turning about the pivot, integrated here every step (θ'' = τ / I, lever-plan.ts); the Matter
// bodies (plank, weights) are only placed on that pose, like the pulley: the weights are fixed to the plank (same spot on
// it at every angle, including the small bounce on the floor), and their velocity is the plank's turning (ω × r). Gravity is read from the engine each step, so
// the slider, voice and Moon mode apply at once. The fall is slowed to about TARGET_TIP_S on screen (gravityScale),
// and units.ts plays the physical time at the matching slow-motion factor.

import Matter from 'matter-js';
import type { CleanPart, LeverInfo, LeverSide, Point, SceneBuilder, Sprite, Untidy, ValueSource } from '../types';
import { STEP_ACCEL, STEP_MS, noteFor, scaleFor } from '../units';
import { buildFallback } from './fallback';
import { cutSprite, eraseFromPaper } from './common';
import {
  findLever,
  floorLimits,
  framePoint,
  balanceOf,
  imbalance,
  leverInertia,
  leverTorque,
  LeverMotion,
  PLANK_MASS_SHARE,
  riding,
  rodInertia,
  type LeverItem,
  type LeverWeight,
} from './lever-plan';
import { fmt, TIDY, TIDY_MAX_DEG, tidyLog, untidyMatters } from './tidy';

/** Heavier : lighter drawn weight is capped at this (a drawn box 10× bigger would slam down). */
const MAX_MASS_RATIO = 4;
/** Seconds on screen for the plank to reach the floor at Earth gravity (never faster than real gravity on the paper). */
const TARGET_TIP_S = 1.6;

const rad = (d: number) => (d * Math.PI) / 180;

export const buildLever: SceneBuilder = (input) => {
  const { width: W, height: H } = input;
  const f = findLever(input.ink, W, H, false);
  if (!f) return buildFallback(input);
  if (new URLSearchParams(location.search).has('debug')) console.log(`[lever] ${f.why}`);

  const len = f.uMax - f.uMin;
  const drawnRad = rad(f.deg);
  // Tidy-up: a plank within 15° of level was meant to be level (the triangle's base too). Steeper starts as drawn.
  let theta0 = TIDY && Math.abs(f.deg) <= TIDY_MAX_DEG ? 0 : drawnRad;
  const drawnThick = f.vBot - f.vTop;
  // The clean plank: as thick as drawn, but never a hairline.
  const T = Math.min(0.12 * len, Math.max(drawnThick, 2.2 * f.stroke, 0.022 * len));
  const baseY = (f.baseL.y + f.baseR.y) / 2;
  const P = f.pivot;
  const depth = Math.max(4, baseY - P.y);

  // ---- Masses (drawn area, lighter = 1 kg; or entered) ----
  const sides = { left: f.left, right: f.right };
  let kgL = 0, kgR = 0;
  if (f.left && f.right) {
    const lo = Math.min(f.left.area, f.right.area);
    kgL = Math.min(MAX_MASS_RATIO, f.left.area / lo);
    kgR = Math.min(MAX_MASS_RATIO, f.right.area / lo);
  } else if (f.left) kgL = 1;
  else if (f.right) kgR = 1;
  const noteKgL = f.left ? noteFor(input.analysis, 'mass', ['left weight'])?.value : undefined;
  const noteKgR = f.right ? noteFor(input.analysis, 'mass', ['right weight'])?.value : undefined;
  let kgFromL: ValueSource = 'assumed', kgFromR: ValueSource = 'assumed';
  if (noteKgL !== undefined && noteKgR !== undefined) {
    kgL = noteKgL;
    kgR = noteKgR;
    kgFromL = kgFromR = 'input';
  } else if (noteKgL !== undefined) {
    if (f.right) kgR = noteKgL * (kgR / kgL);
    kgL = noteKgL;
    kgFromL = 'input';
  } else if (noteKgR !== undefined) {
    if (f.left) kgL = noteKgR * (kgL / kgR);
    kgR = noteKgR;
    kgFromR = 'input';
  }

  // ---- Distances (drawn, or entered: the weight slides along the plank) ----
  const centreU = (w: LeverWeight) => (w.u0 + w.u1) / 2;
  const drawnD = { left: f.left ? -centreU(f.left) : 0, right: f.right ? centreU(f.right) : 0 };
  const drawnMeasures: Record<string, number> = {};
  if (f.left) drawnMeasures['left weight'] = drawnD.left;
  if (f.right) drawnMeasures['right weight'] = drawnD.right;
  // The scale (px per metre) follows the same rule as every scene: an entered distance sets it (that weight stays).
  const scale0 = scaleFor(input, drawnMeasures);
  const pxPerM = scale0.pxPerMeter;
  const dPx = { ...drawnD };
  const dFrom: Record<'left' | 'right', ValueSource> = { left: scale0.note ? 'scaled' : 'assumed', right: scale0.note ? 'scaled' : 'assumed' };
  for (const s of ['left', 'right'] as const) {
    const w = sides[s];
    if (!w) continue;
    const part = s === 'left' ? 'left weight' : 'right weight';
    const note = noteFor(input.analysis, 'length', [part]);
    if (!note) continue;
    dFrom[s] = 'input';
    if (scale0.note?.part === part) continue; // set the scale: already exactly there
    const halfW = (w.u1 - w.u0) / 2;
    const end = s === 'left' ? -f.uMin : f.uMax;
    const want = note.value * pxPerM;
    const lo = Math.min(halfW, end), hi = Math.max(lo, end - halfW);
    dPx[s] = Math.min(hi, Math.max(lo, want));
    if (Math.abs(dPx[s] - want) > 0.5) dFrom[s] = 'adjusted';
  }

  // ---- The rigid body in the plank frame (u along it from the pivot, v across, < 0 above) ----
  interface Piece {
    w: LeverWeight;
    kg: number;
    u: number;
    v: number;
    width: number;
    height: number;
    drawn: Point;
  }
  const pieces: Piece[] = [];
  for (const s of ['left', 'right'] as const) {
    const w = sides[s];
    if (!w) continue;
    const height = f.vTop - w.v0;
    const width = w.u1 - w.u0;
    pieces.push({
      w,
      kg: s === 'left' ? kgL : kgR,
      u: s === 'left' ? -dPx.left : dPx.right,
      // Tidy: the weight sits on the clean plank's top; else as drawn.
      v: TIDY ? -T - height / 2 : (w.v0 + f.vTop) / 2,
      width,
      height,
      drawn: framePoint(f, centreU(w), (w.v0 + f.vTop) / 2),
    });
  }
  const items: LeverItem[] = pieces.map((p) => ({ m: p.kg, u: p.u, v: p.v }));
  const totalKg = pieces.reduce((s, p) => s + p.kg, 0) || 1;
  const limits = floorLimits(f.uMin, f.uMax, depth);
  const model = { items, plankI: rodInertia(PLANK_MASS_SHARE * totalKg, f.uMin, f.uMax), ...limits };

  const allInput = pieces.length === 2 && kgFromL === 'input' && kgFromR === 'input' && dFrom.left !== 'scaled' && dFrom.left !== 'assumed' && dFrom.right !== 'scaled' && dFrom.right !== 'assumed';
  const tilt = imbalance(model);
  // Typed values: balanced only when m₁d₁ = m₂d₂. Drawn sizes: close moments are "nearly balanced" (a small tilt).
  const verdict = balanceOf(tilt, allInput, pieces.length === 2);
  const { balanced } = verdict;
  // Drawn already resting on the side it tips to (a steep drawn plank): start level instead, so it visibly tips.
  const tauSign = Math.sign(leverTorque(model, theta0, 1));
  const room = (th: number) => (tauSign > 0 ? model.thetaMax - th : th - model.thetaMin);
  if (!balanced && tauSign !== 0 && room(theta0) < rad(3)) theta0 = 0;
  const motion = new LeverMotion(model, theta0, balanced, verdict.settle);

  // Slow-down so the tip takes ~TARGET_TIP_S on screen: θ = α t² / 2 => scale = 2 θ / (α T²), α at Earth gravity.
  const alpha0 = Math.abs(leverTorque(model, theta0, STEP_ACCEL)) / leverInertia(model);
  const travel = Math.max(rad(2), room(theta0));
  const steps = TARGET_TIP_S * (1000 / STEP_MS);
  const gScale = !balanced && alpha0 > 0 ? Math.min(1, Math.max(0.02, (2 * travel) / (alpha0 * steps * steps))) : 1;

  // ---- Bodies ----
  const ghost = { collisionFilter: { group: -1, category: 0, mask: 0 }, frictionAir: 0, friction: 0 };
  const uc = (f.uMin + f.uMax) / 2;
  const plank = Matter.Bodies.rectangle(0, 0, len, T, ghost);
  const plankLocal = { u: uc, v: -T / 2 };
  const weights = pieces.map((p) => Matter.Bodies.rectangle(0, 0, Math.max(4, p.width), Math.max(4, p.height), ghost));
  const place = (b: Matter.Body, u: number, v: number, th: number, w: number) => {
    const r = riding(P, u, v, th, w);
    Matter.Body.setPosition(b, r.at);
    Matter.Body.setAngle(b, th);
    // setVelocity / setAngularVelocity also set the previous pose (Verlet): nothing of the engine's own step remains.
    Matter.Body.setVelocity(b, r.vel);
    Matter.Body.setAngularVelocity(b, w);
  };
  const pose = () => {
    const w = motion.hold > 0 ? 0 : motion.omega;
    place(plank, plankLocal.u, plankLocal.v, motion.theta, w);
    pieces.forEach((p, i) => place(weights[i], p.u, p.v, motion.theta, w));
  };
  pose();
  // Same pose, zero velocity, for the first frame (setVelocity uses the previous position).
  for (const b of [plank, ...weights]) Matter.Body.setVelocity(b, { x: 0, y: 0 });
  const tidyPlank = { ...plank.position };
  const tidyWeights = weights.map((b) => ({ ...b.position }));

  const onStep = (engine: Matter.Engine) => {
    // Engine gravity (slider / voice / Moon mode) in px per step², at this drawing's slow-down.
    const g = engine.gravity.y * engine.gravity.scale * STEP_MS * STEP_MS * gScale;
    motion.step(g);
    pose();
  };

  // ---- Hand-drawn cut-outs ----
  const maskOf = (pix: number[]) => {
    const m = new Uint8Array(W * H);
    const r = 2;
    for (const i of pix) {
      const x = i % W, y = (i - x) / W;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) m[yy * W + xx] = 1;
        }
    }
    return m;
  };
  const plankMask = maskOf(f.plankPixels);
  const weightMasks = pieces.map((p) => maskOf(p.w.pixels));
  const drawnPlank = framePoint(f, uc, (f.vTop + f.vBot) / 2);
  const sprites: Sprite[] = [
    { ...cutSprite(input, plankMask), follow: { kind: 'body', body: plank, origin: drawnPlank, originAngle: drawnRad } },
    ...pieces.map((p, i): Sprite => ({ ...cutSprite(input, weightMasks[i]), follow: { kind: 'body', body: weights[i], origin: p.drawn, originAngle: drawnRad } })),
  ];

  // ---- Clean figure: floor, grey triangle, dark plank, orange weights (all turning with the plank) ----
  const tidyNotes: string[] = [];
  const turn = drawnRad - theta0;
  const untidyOf = (tidy: Point, drawn: Point): Untidy => ({ about: { ...tidy }, dx: drawn.x - tidy.x, dy: drawn.y - tidy.y, angle: turn, scale: 1 });
  const span = [P.x + f.uMin * Math.cos(model.thetaMin), P.x + f.uMax * Math.cos(model.thetaMax), f.baseL.x, f.baseR.x];
  const ground: CleanPart = { kind: 'ground', y: baseY, x0: Math.max(0, Math.min(...span) - 0.06 * len), x1: Math.min(W, Math.max(...span) + 0.06 * len) };
  const triangle: CleanPart = {
    kind: 'solid',
    points: [{ ...P }, { x: f.baseR.x, y: baseY }, { x: f.baseL.x, y: baseY }],
  };
  if (TIDY) triangle.drawnPoints = [f.tip, f.baseR, f.baseL];
  const plankPart: CleanPart = { kind: 'body', body: plank, tone: 'beam' };
  const weightParts: CleanPart[] = weights.map((b) => ({ kind: 'body', body: b, tone: 'mass' }));
  if (TIDY) {
    const up = untidyOf(tidyPlank, drawnPlank);
    if (untidyMatters(up, len / 2)) plankPart.untidy = up;
    pieces.forEach((p, i) => {
      const u = untidyOf(tidyWeights[i], p.drawn);
      if (untidyMatters(u, Math.max(p.width, p.height) / 2)) weightParts[i].untidy = u;
    });
    tidyNotes.push(
      `plank ${fmt(f.deg)} → ${theta0 === 0 ? '0°' : `${fmt(f.deg)} (kept: slanted on purpose)`}`,
      `pivot base ${fmt((Math.atan2(f.baseR.y - f.baseL.y, f.baseR.x - f.baseL.x) * 180) / Math.PI)} → 0°`,
      `plank thickness ${drawnThick.toFixed(0)}px → ${T.toFixed(0)}px, weights rest on it`,
    );
  }
  tidyLog('Seesaw', tidyNotes);

  // ---- Readouts ----
  const sideInfo = (s: 'left' | 'right'): LeverSide | null => {
    if (!sides[s]) return null;
    return { kg: s === 'left' ? kgL : kgR, kgFrom: s === 'left' ? kgFromL : kgFromR, d: dPx[s] / pxPerM, dFrom: dFrom[s] };
  };
  const lever: LeverInfo = {
    left: sideInfo('left'),
    right: sideInfo('right'),
    balanced,
    nearly: verdict.nearly,
    pivot: { ...P },
    thetaMin: model.thetaMin,
    thetaMax: model.thetaMax,
    theta: () => motion.theta,
  };
  const rMax = Math.max(...items.map((it) => Math.hypot(it.u, it.v)), f.uMax, -f.uMin);
  const gNow = (input.analysis.params.gravity || 9.8) / 9.8;
  const omegaMax = balanced ? (2 * Math.PI * rad(2.5)) / 70 : Math.sqrt(2 * alpha0 * gScale * gNow * travel);
  const measures: Record<string, number> = {};
  if (f.left) measures['left weight'] = dPx.left;
  if (f.right) measures['right weight'] = dPx.right;
  const parts: NonNullable<ReturnType<SceneBuilder>['parts']> = {};
  pieces.forEach((p, i) => {
    const name = p.u < 0 ? 'left weight' : 'right weight';
    parts[name] = {
      at: () => weights[i].position,
      clear: Math.max(p.width, p.height) / 2,
      side: 'above',
      body: weights[i],
      kg: p.kg,
      kgFrom: p.u < 0 ? kgFromL : kgFromR,
    };
  });

  return {
    bodies: [plank, ...weights],
    constraints: [],
    sprites,
    background: eraseFromPaper(input, [plankMask, ...weightMasks]),
    label: 'Seesaw',
    onStep,
    clean: [ground, triangle, plankPart, ...weightParts],
    gravityScale: gScale,
    speedHint: Math.max(1e-3, omegaMax * rMax),
    measures,
    parts,
    physics: { lever },
  };
};
