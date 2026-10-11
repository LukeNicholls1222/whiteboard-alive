// Ball collision: two balls drawn on a floor line, each with an arrow for where it is going (one arrow is enough),
// roll towards each other and collide, bounce off the walls at the picture's sides, and collide again.
//
// The motion is the exact 1-D one of collision-physics.ts (not Matter's contacts, which do not conserve momentum
// exactly): the Matter bodies only carry the balls' positions and velocities for the renderer, the arrows and the
// graph. Starting speed = the arrow's length (ARROW_SPEED), a ball without an arrow waits; mass = the drawn area
// (the smaller ball is 1 kg). Both can be typed into "Your numbers"; the bounciness e is a slider (params.bounciness,
// read at every hit). When the balls have (nearly) stopped, or after MAX_RUN_MS, everything plays again.
//
// Works without AI roles: the balls are round closed loops (or filled dots) side by side on one line, the arrows the
// level strokes beside or above them, the floor the long level line under them (tidy: made level, the balls set on it).

import Matter from 'matter-js';
import type { CleanPart, Contour, PartInfo, PartName, Point, SceneBuilder, SceneInput, Sprite, ValueSource } from '../types';
import { inkImage } from '../clean';
import { contourMask, cutSprite, eraseFromPaper, maskBounds, roleOf } from './common';
import { DEFAULT_KG, mps, noteFor, pxPerStep, scaleFor } from '../units';
import { STEP_MS } from '../sim';
import { fmt, inkSegment, segmentY, TIDY, tidyLog, untidyMatters, untidyMove, untidySegment, untidyTurn, type InkSegment } from './tidy';
import {
  axisOf,
  discMask,
  EMBEDDED_INK,
  inkAround,
  inkComponents,
  makeBall,
  ringStroke,
  roundHoles,
  type Axis,
  type Ball,
  type HoleCand,
} from './projectile';
import { advance, atRest, clampPair, kinetic, type Ball1D, type Walls } from './collision-physics';

/** Starting speed per px of drawn arrow: screen px per second (an arrow is where the ball gets in 1 / ARROW_SPEED s). */
const ARROW_SPEED = 2;
/** Arrows within this many degrees of level count (a steeper one is not a rolling direction). */
const ARROW_MAX_DEG = 25;
/** Walls this share of the picture's width in from its sides. */
const WALL_IN = 0.012;
/** Walls are drawn this × the bigger ball's radius tall. */
const WALL_TALL = 2.6;
/** Once stopped, the still picture stays this long, then it plays again. */
const HOLD_MS = 1800;
/** A run that never stops (elastic) plays again after this long, so the drawn start is seen again. */
const MAX_RUN_MS = 30000;
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

interface Drawn {
  ball: Ball;
  /** Starting velocity from the drawn arrow, px per step (right = +); 0 without an arrow. */
  v: number;
  /** The arrow, tail to head, and its ink. */
  arrow: { from: Point; to: Point } | null;
}

/** Which end of an arrow is its head: the one whose ink spreads widest across the shaft (barbs). 0 = cannot tell. */
function headSign(ax: Axis): number {
  const zone = (ax.max - ax.min) * 0.3;
  let lo = 0, hi = 0;
  for (const p of ax.pixels) {
    const dx = p.x - ax.centroid.x, dy = p.y - ax.centroid.y;
    const t = dx * ax.dir.x + dy * ax.dir.y;
    const n = Math.abs(-dx * ax.dir.y + dy * ax.dir.x);
    if (t > ax.max - zone) hi = Math.max(hi, n);
    if (t < ax.min + zone) lo = Math.max(lo, n);
  }
  return Math.abs(hi - lo) < 1 ? 0 : hi > lo ? 1 : -1;
}

/** Round candidates: closed loops (pen gaps bridged), else filled dots. */
function roundCandidates(input: SceneInput): HoleCand[] {
  const { width: W, height: H, ink } = input;
  const out: HoleCand[] = [];
  for (const d of [2, 4]) {
    for (const h of roundHoles(ink, W, H, d)) {
      if (h.hasInner || inkAround(ink, W, H, h.center, h.r) > EMBEDDED_INK) continue;
      if (out.some((o) => Math.hypot(o.center.x - h.center.x, o.center.y - h.center.y) < Math.max(o.r, h.r))) continue;
      out.push(h);
    }
  }
  return out;
}

/** The pair of round things that sit side by side on one line (bottoms level within 15°), left first. */
function pickPair(c: { center: Point; r: number }[]): [number, number] | null {
  let best: [number, number] | null = null, bestScore = Infinity;
  for (let i = 0; i < c.length; i++)
    for (let j = 0; j < c.length; j++) {
      const a = c[i], b = c[j];
      const dx = b.center.x - a.center.x;
      if (dx < 0.9 * (a.r + b.r)) continue;
      const dBottom = Math.abs(b.center.y + b.r - (a.center.y + a.r));
      if (dBottom > Math.tan((15 * Math.PI) / 180) * dx + 0.3 * Math.max(a.r, b.r)) continue;
      const score = dBottom / dx + 0.3 * Math.abs(Math.log(a.r / b.r));
      if (score < bestScore) {
        bestScore = score;
        best = [i, j];
      }
    }
  return best;
}

/** The two balls (AI's projectile roles first, else from the ink), left one first. */
function findBalls(input: SceneInput, labelled: Contour[]): [Ball, Ball] {
  const { width: W, height: H, ink } = input;
  const fromRoles = labelled
    .filter((c) => c.bbox.w / Math.max(1, c.bbox.h) > 0.6 && c.bbox.w / Math.max(1, c.bbox.h) < 1.6)
    .map((c): Ball => {
      const mask = contourMask(input, [c]);
      const b = maskBounds(mask, W, H) ?? { x: c.bbox.x, y: c.bbox.y, w: c.bbox.w, h: c.bbox.h };
      const r = Math.max(6, Math.max(b.w, b.h) / 2);
      return { center: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, r, stroke: Math.max(2, r * 0.15), mask };
    });
  if (fromRoles.length >= 2) {
    const p = pickPair(fromRoles) ?? [0, 1];
    const pair = [fromRoles[p[0]], fromRoles[p[1]]].sort((a, b) => a.center.x - b.center.x);
    return [pair[0], pair[1]];
  }
  const holes = roundCandidates(input);
  // Filled dots: small, compact, solid contours.
  const minDim = Math.min(W, H);
  for (const c of input.contours) {
    const { w, h } = c.bbox;
    const size = Math.max(w, h);
    if (size < minDim * 0.03 || size > minDim * 0.3 || w / h < 0.6 || w / h > 1.65 || c.inkPixels / (w * h) < 0.5) continue;
    const center = { x: c.bbox.x + w / 2, y: c.bbox.y + h / 2 };
    if (holes.some((o) => Math.hypot(o.center.x - center.x, o.center.y - center.y) < o.r + size / 2)) continue;
    holes.push({ center, r: -size / 2, hasInner: false }); // r < 0 marks a dot
  }
  const cand = holes.map((h) => ({ center: h.center, r: Math.abs(h.r) }));
  let p = pickPair(cand);
  if (!p && cand.length >= 2) {
    const big = cand.map((_, i) => i).sort((i, j) => cand[j].r - cand[i].r).slice(0, 2);
    p = cand[big[0]].center.x < cand[big[1]].center.x ? [big[0], big[1]] : [big[1], big[0]];
  }
  if (!p) throw new Error(`collision: ${cand.length} ball(s) found, need two`);
  const make = (k: number): Ball => {
    const h = holes[k];
    if (h.r < 0) {
      const r = -h.r;
      return { center: h.center, r, stroke: r, mask: discMask(W, H, h.center, r + 1.5) };
    }
    return makeBall(input, h.center, h.r, ringStroke(ink, W, H, h.center, h.r));
  };
  return [make(p[0]), make(p[1])];
}

export const buildCollision: SceneBuilder = (input) => {
  const { width: W, height: H, ink } = input;
  const params = input.analysis.params;
  const byRole = (...roles: string[]) =>
    input.contours.filter((c) => {
      const r = roleOf(input, c.id);
      return !!r && roles.includes(r.role);
    });
  const balls = findBalls(input, byRole('projectile', 'bob'));
  const ballInk = new Uint8Array(W * H);
  for (const b of balls) for (let i = 0; i < ballInk.length; i++) if (b.mask[i]) ballInk[i] = 1;

  // --- Arrows: level strokes beside or above a ball (AI's arrow roles, else every such stroke of the ink) ---
  const cut = new Uint8Array(W * H);
  for (const b of balls) {
    const m = discMask(W, H, b.center, b.r + 3);
    for (let i = 0; i < m.length; i++) if (m[i]) cut[i] = 1;
  }
  const roleArrows = byRole('arrow');
  let comps: Point[][];
  if (roleArrows.length) {
    const am = contourMask(input, roleArrows, 3);
    comps = inkComponents(ink, cut.map((v, i) => (v || !am[i] ? 1 : 0)), W, H, 15);
  } else comps = inkComponents(ink, cut, W, H, 15);
  const drawn: Drawn[] = balls.map((ball) => ({ ball, v: 0, arrow: null }));
  const arrowInk = new Uint8Array(W * H);
  const best: ({ ax: Axis; px: Point[]; score: number } | null)[] = [null, null];
  for (const px of comps) {
    const ax = axisOf(px);
    if (!ax || ax.elongation < 3) continue;
    const len = ax.max - ax.min;
    const deg = Math.abs((Math.atan2(ax.dir.y, ax.dir.x) * 180) / Math.PI);
    if (Math.min(deg, 180 - deg) > ARROW_MAX_DEG || len > 0.45 * W) continue;
    const x0 = ax.centroid.x - (len / 2) * Math.abs(ax.dir.x), x1 = ax.centroid.x + (len / 2) * Math.abs(ax.dir.x);
    balls.forEach((b, k) => {
      const { center: c, r } = b;
      if (len < Math.max(0.5 * r, 12)) return;
      // Beside or above the ball (a floor piece next to it is lower than its middle).
      if (x1 < c.x - 3 * r || x0 > c.x + 3 * r || ax.centroid.y < c.y - 3.5 * r || ax.centroid.y > c.y + 0.6 * r) return;
      const gapX = Math.max(0, x0 - c.x, c.x - x1);
      const score = gapX + 0.5 * Math.abs(ax.centroid.y - c.y);
      if (!best[k] || score < best[k]!.score) best[k] = { ax, px, score };
    });
  }
  // One stroke can be nearest to both balls: it belongs to the closer one.
  if (best[0] && best[1] && best[0].px === best[1].px) best[best[0].score <= best[1].score ? 1 : 0] = null;
  const stepSpeed = ARROW_SPEED / (1000 / STEP_MS);
  best.forEach((a, k) => {
    if (!a) return;
    const { ax } = a;
    const other = balls[1 - k].center.x - balls[k].center.x;
    // Head = the barbed end; can't tell: an arrow starting at the ball points away from it, else at the other ball.
    let sign = headSign(ax) * Math.sign(ax.dir.x || 1);
    if (!sign) {
      const fromBall = Math.abs(ax.centroid.y - balls[k].center.y) < balls[k].r;
      sign = fromBall ? Math.sign(ax.centroid.x - balls[k].center.x) || 1 : Math.sign(other) || 1;
    }
    const dx = Math.abs(ax.dir.x) * (ax.max - ax.min);
    drawn[k].v = sign * dx * stepSpeed;
    const at = (t: number) => ({ x: ax.centroid.x + ax.dir.x * t, y: ax.centroid.y + ax.dir.y * t });
    const ends = [at(ax.min), at(ax.max)].sort((p, q) => p.x - q.x);
    drawn[k].arrow = sign > 0 ? { from: ends[0], to: ends[1] } : { from: ends[1], to: ends[0] };
    for (const p of a.px) arrowInk[p.y * W + p.x] = 1;
  });

  // --- Floor: the long line along the balls' bottoms (AI's ground role first) ---
  const [A, B] = balls;
  const bottomAt = (x: number) => A.center.y + A.r + ((x - A.center.x) * (B.center.y + B.r - A.center.y - A.r)) / (B.center.x - A.center.x || 1);
  const band = Math.max(0.04 * H, 0.5 * Math.max(A.r, B.r));
  const groundRole = byRole('ground', 'incline');
  const roleMask = groundRole.length ? contourMask(input, groundRole, 3) : null;
  const onLine = (i: number) => {
    const x = i % W, y = (i - x) / W;
    return !ballInk[i] && !arrowInk[i] && (!roleMask || roleMask[i] === 1) && Math.abs(y - bottomAt(x)) <= band;
  };
  let seg: InkSegment | null = inkSegment(ink, W, H, { x0: 0, x1: W - 1, y0: Math.min(bottomAt(0), bottomAt(W)) - band, y1: Math.max(bottomAt(0), bottomAt(W)) + band }, onLine);
  if (seg && seg.b.x - seg.a.x < 0.25 * W) seg = null;
  const tidyNotes: string[] = [];
  const mid = (A.center.x + B.center.x) / 2;
  /** Top of the (levelled) floor the balls roll on. */
  let floorY: number;
  const floorLine = { y: 0, untidy: null as ReturnType<typeof untidyTurn> | null };
  if (seg) {
    const y = segmentY(seg, mid);
    floorY = y - seg.thick / 2;
    floorLine.y = y;
    const turn = Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x);
    if (TIDY) {
      const u = untidyTurn({ x: mid, y }, turn);
      if (untidyMatters(u, (seg.b.x - seg.a.x) / 2)) floorLine.untidy = u;
      tidyNotes.push(`floor ${fmt(seg.deg)} → 0°`);
    }
  } else {
    floorY = Math.max(A.center.y + A.r, B.center.y + B.r);
    floorLine.y = floorY;
    tidyNotes.push('no floor line found (balls roll at their lowest bottom)');
  }

  // --- Balls on the floor, masses, speeds ---
  const scale = scaleFor(input, {});
  const bodyR = balls.map((b) => Math.max(5, b.r - b.stroke * 0.5));
  const rMin = Math.min(...bodyR);
  const sides: PartName[] = ['left ball', 'right ball'];
  const kgOf = (k: number): { kg: number; from: ValueSource } => {
    const note = noteFor(input.analysis, 'mass', [sides[k]]);
    if (note && note.value > 0) return { kg: note.value, from: 'input' };
    return { kg: Number(((bodyR[k] / rMin) ** 2).toPrecision(2)) * DEFAULT_KG, from: 'drawn' };
  };
  const mass = [kgOf(0), kgOf(1)];
  // Drawn speeds (arrows); nothing drawn sets anything moving: the left ball is pushed at the right one (something
  // always moves). Typed speeds replace them.
  const drawnV = drawn.map((d) => d.v);
  const drawnFrom: ValueSource[] = ['drawn', 'drawn'];
  if (!drawnV[0] && !drawnV[1]) {
    drawnV[0] = 3 * bodyR[0] * stepSpeed;
    drawnFrom[0] = 'auto';
  }
  const speedFrom: ValueSource[] = [...drawnFrom];
  const v0 = drawnV.map((v, k) => {
    const note = noteFor(input.analysis, 'speed', [sides[k]]);
    if (!note) return v;
    speedFrom[k] = 'input';
    return pxPerStep(note.value, scale);
  });
  const walls: Walls = { x0: WALL_IN * W, x1: W - WALL_IN * W };
  const start: [Ball1D, Ball1D] = [0, 1].map((k) => ({ x: balls[k].center.x, v: v0[k], r: bodyR[k], m: mass[k].kg })) as [Ball1D, Ball1D];
  clampPair(start, walls);
  const startY = [0, 1].map((k) => (TIDY ? floorY - bodyR[k] : balls[k].center.y));
  const vStart = Math.max(Math.abs(v0[0]), Math.abs(v0[1]));

  const bodies = [0, 1].map((k) =>
    Matter.Bodies.circle(start[k].x, startY[k], bodyR[k], { frictionAir: 0, friction: 0, collisionFilter: { group: 0, category: 1, mask: 0 } }),
  );
  const state: [Ball1D, Ball1D] = [{ ...start[0] }, { ...start[1] }];
  /** Body angle rolls with the distance travelled (rolling without slipping). */
  const write = () =>
    state.forEach((s, k) => {
      Matter.Body.setPosition(bodies[k], { x: s.x, y: startY[k] });
      Matter.Body.setVelocity(bodies[k], { x: s.v, y: 0 });
      Matter.Body.setAngle(bodies[k], (s.x - start[k].x) / bodyR[k]);
      Matter.Body.setAngularVelocity(bodies[k], 0);
    });
  write();
  if (DEBUG)
    console.log(
      `[collision] balls ${balls.map((b, k) => `(${Math.round(b.center.x)},${Math.round(b.center.y)}) r=${b.r.toFixed(1)} ${mass[k].kg} kg v=${v0[k].toFixed(2)} px/step${drawn[k].arrow ? ' arrow' : ''}`).join(' | ')} floor ${seg ? `${seg.deg.toFixed(1)}° y=${floorY.toFixed(0)}` : 'none'} walls ${walls.x0.toFixed(0)}..${walls.x1.toFixed(0)}`,
    );

  // --- Run, stop, play again ---
  const holdSteps = Math.round(HOLD_MS / STEP_MS);
  const maxSteps = Math.round(MAX_RUN_MS / STEP_MS);
  let run = 0;
  let held = -1;
  const restart = () => {
    state[0] = { ...start[0] };
    state[1] = { ...start[1] };
    run = 0;
    held = -1;
  };
  const onStep = () => {
    if (held >= 0) {
      if (++held >= holdSteps) restart();
    } else {
      const e = Math.min(1, Math.max(0, Number(params.bounciness ?? 1)));
      advance(state, 1, walls, Number.isFinite(e) ? e : 1);
      if (++run >= maxSteps) restart();
      else if (run > 10 && atRest(state, vStart)) {
        state[0].v = state[1].v = 0;
        held = 0;
      }
    }
    write();
  };

  // --- Picture ---
  const sprites: Sprite[] = balls.map((b, k) => {
    const { image, offset } = cutSprite(input, b.mask);
    return { image, offset, follow: { kind: 'body', body: bodies[k], origin: { x: start[k].x, y: startY[k] }, originAngle: 0 } };
  });
  const floorInk = new Uint8Array(W * H);
  if (seg) {
    const t = seg.thick / 2 + Math.max(4, 0.008 * H);
    for (let y = Math.max(0, Math.floor(Math.min(seg.a.y, seg.b.y) - t)); y <= Math.min(H - 1, Math.ceil(Math.max(seg.a.y, seg.b.y) + t)); y++)
      for (let x = Math.max(0, Math.floor(seg.a.x - t)); x <= Math.min(W - 1, Math.ceil(seg.b.x + t)); x++)
        if (Math.abs(y - segmentY(seg, x)) <= t) floorInk[y * W + x] = 1;
  }
  const notScenery = new Uint8Array(W * H);
  for (let i = 0; i < notScenery.length; i++) if (ballInk[i] || arrowInk[i] || floorInk[i]) notScenery[i] = 1;
  const keep = new Uint8Array(W * H);
  for (const comp of inkComponents(ink, notScenery, W, H, Math.max(30, Math.round(0.0015 * W * H)))) for (const p of comp) keep[p.y * W + p.x] = 1;

  const clean: CleanPart[] = [];
  const sceneryInk = inkImage(input, (i) => keep[i] === 1);
  if (sceneryInk) clean.push({ kind: 'image', ...sceneryInk });
  const ground: CleanPart = { kind: 'ground', y: TIDY ? floorLine.y : floorY };
  if (floorLine.untidy) ground.untidy = floorLine.untidy;
  clean.push(ground);
  const wallH = WALL_TALL * Math.max(...bodyR);
  const wallTop = floorLine.y - wallH;
  clean.push({ kind: 'support', from: { x: walls.x0, y: floorLine.y }, to: { x: walls.x0, y: wallTop }, side: { x: -1, y: 0 } });
  clean.push({ kind: 'support', from: { x: walls.x1, y: floorLine.y }, to: { x: walls.x1, y: wallTop }, side: { x: 1, y: 0 } });
  drawn.forEach((d) => {
    if (!d.arrow) return;
    // Meant to be level (it gave a level velocity): straightened at its middle height.
    const y = (d.arrow.from.y + d.arrow.to.y) / 2;
    const tidy = TIDY ? { from: { x: d.arrow.from.x, y }, to: { x: d.arrow.to.x, y } } : d.arrow;
    const part: CleanPart = { kind: 'arrow', ...tidy };
    if (TIDY) {
      const u = untidySegment(tidy.from, tidy.to, d.arrow.from, d.arrow.to);
      if (untidyMatters(u, Math.abs(tidy.to.x - tidy.from.x) / 2)) part.untidy = u;
    }
    clean.push(part);
  });
  bodies.forEach((body, k) => {
    const part: CleanPart = { kind: 'ball', body, radius: bodyR[k], tone: k === 0 ? 'mass' : 'mass2' };
    const u = untidyMove(balls[k].center, { x: start[k].x, y: startY[k] });
    if (TIDY && untidyMatters(u, bodyR[k])) part.untidy = u;
    clean.push(part);
  });
  tidyLog('Collision', tidyNotes);

  const parts: Partial<Record<PartName, PartInfo>> = {};
  bodies.forEach((body, k) => {
    parts[sides[k]] = { at: () => body.position, clear: bodyR[k], body, kg: mass[k].kg, kgFrom: mass[k].from, side: 'above' };
  });
  parts.ground = { at: () => ({ x: mid, y: floorLine.y }), side: 'below' };

  // Arrows are scaled to the fastest either ball can ever go: all the kinetic energy in one ball (never more than
  // twice the fastest start, so the first arrows are not tiny next to a light ball's possible speed).
  const ke = kinetic(start);
  const vMax = Math.max(...start.map((s) => Math.sqrt((2 * ke) / s.m)));

  return {
    bodies,
    constraints: [],
    sprites,
    clean,
    background: eraseFromPaper(input, balls.map((b) => b.mask)),
    label: 'Collision',
    onStep,
    measures: {},
    parts,
    physics: {
      ballSpeeds: {
        left: { value: mps(v0[0], scale), from: speedFrom[0], drawn: mps(drawnV[0], scale), drawnFrom: drawnFrom[0] },
        right: { value: mps(v0[1], scale), from: speedFrom[1], drawn: mps(drawnV[1], scale), drawnFrom: drawnFrom[1] },
      },
    },
    speedHint: Math.max(vStart, Math.min(vMax, 2 * vStart)),
  };
};
