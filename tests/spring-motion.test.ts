// Spring + mass motion (src/scenes/spring-motion.ts): the energy graph's Total stays flat and the period is 2π√(m/k),
// for any amplitude, k, m and gravity (Moon), with k and m set independently.
// Run: npm test
//
// Energies are worked out exactly as the graph does (graph.ts): KE = ½ m v² from the block's speed, PE = ½ k d² from
// its distance to the rest position, both in physical units through the drawing's scale (units.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARROW_PAD, BLOCK_PAD, defaultSpringK, SpringOscillator, springSetup, springView } from '../src/scenes/spring-motion.ts';
import { meters, mps, scaleFor, STEP_ACCEL, STEP_S } from '../src/units.ts';
import { MOTION_MAX_S, MOTION_MIN_S, SPRING_SAG_SHARE, springPxPerMeter } from '../src/defaults.ts';

/** A 960 px paper of 1 m (slow motion ≈ 0.33×), as most drawings. */
const SCALE = scaleFor({ width: 960, height: 720, analysis: {} });
const MOON = 1.62 / 9.8;

interface Run {
  /** (max − min) / mean of KE + PE over the run, after the first period. */
  totalSpread: number;
  /** Mean period from the turning points, physical seconds. */
  period: number;
}

/** Runs `periods` swings of a block hanging (gDrawn = STEP_ACCEL) or lying (0) on the spring, under `gNow`. */
function run(kEntered: number | undefined, kgEntered: number | undefined, ampPx: number, opts: { gDrawn?: number; gNow?: number; periods?: number } = {}): Run {
  const { gDrawn = STEP_ACCEL, gNow = gDrawn, periods = 40 } = opts;
  const setup = springSetup(kEntered, kgEntered, SCALE);
  const omega = Math.sqrt(setup.omega2);
  const osc = new SpringOscillator(setup.omega2, gDrawn, ampPx * omega);
  const perSteps = (2 * Math.PI) / omega;
  const n = Math.ceil(periods * perSteps);
  const totals: number[] = [];
  const flips: number[] = [];
  let prevV = osc.v;
  for (let i = 1; i <= n; i++) {
    osc.step(gNow);
    const v = mps(osc.v, SCALE);
    const d = meters(osc.stretch(), SCALE);
    if (i > perSteps) totals.push(0.5 * setup.kg * v * v + 0.5 * setup.k * d * d);
    // Turning point: v changes sign; interpolate where.
    if ((prevV > 0 && osc.v <= 0) || (prevV < 0 && osc.v >= 0)) flips.push(i - 1 + prevV / (prevV - osc.v));
    prevV = osc.v;
  }
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  const halves = flips.slice(1).map((f, i) => f - flips[i]);
  const periodSteps = (2 * halves.reduce((a, b) => a + b, 0)) / halves.length;
  return { totalSpread: (Math.max(...totals) - Math.min(...totals)) / mean, period: periodSteps * STEP_S * SCALE.timeFactor };
}

const theory = (k: number, kg: number) => 2 * Math.PI * Math.sqrt(kg / k);

test('Total stays within 1 % and the period is 2π√(m/k) within 1 %, for any amplitude, k, m and Moon', () => {
  const k0 = defaultSpringK();
  const cases: [string, number | undefined, number | undefined, number, { gDrawn?: number; gNow?: number }][] = [
    ['default', undefined, undefined, 40, {}],
    ['small swing', undefined, undefined, 12, {}],
    ['big swing', undefined, undefined, 80, {}],
    ['Moon', undefined, undefined, 40, { gNow: STEP_ACCEL * MOON }],
    ['lying on a floor', undefined, undefined, 40, { gDrawn: 0 }],
    ['heavy block', undefined, 5, 40, {}],
    ['light block', undefined, 0.05, 40, {}],
    ['soft spring', 5, undefined, 40, {}],
    ['stiff spring', 2000, undefined, 40, {}],
    ['both entered', 50, 2, 40, { gNow: STEP_ACCEL * MOON }],
  ];
  for (const [name, k, kg, amp, opts] of cases) {
    const r = run(k, kg, amp, opts);
    assert.ok(r.totalSpread < 0.01, `${name}: Total spread ${(100 * r.totalSpread).toFixed(3)} %`);
    const T = theory(k ?? k0, kg ?? 1);
    assert.ok(Math.abs(r.period / T - 1) < 0.01, `${name}: period ${r.period.toFixed(4)} s vs 2π√(m/k) ${T.toFixed(4)} s`);
  }
});

test('the drawing is the rest position under normal gravity; Moon gravity moves the rest position up by Δg/ω²', () => {
  const setup = springSetup(undefined, undefined, SCALE);
  const osc = new SpringOscillator(setup.omega2, STEP_ACCEL, 0);
  for (let i = 0; i < 500; i++) osc.step(STEP_ACCEL);
  assert.ok(Math.abs(osc.u) < 1e-9, `still at the drawing: ${osc.u}`);
  assert.ok(Math.abs(osc.restAt(STEP_ACCEL * MOON) + (STEP_ACCEL * (1 - MOON)) / setup.omega2) < 1e-9);
});

test('mass and spring constant are independent: a heavier block keeps k and swings √m slower; a stiffer spring keeps m', () => {
  const light = springSetup(undefined, 1, SCALE);
  const heavy = springSetup(undefined, 1.5, SCALE);
  assert.equal(heavy.k, light.k);
  assert.equal(heavy.kg, 1.5);
  assert.ok(Math.abs(run(undefined, 1.5, 40).period / run(undefined, 1, 40).period - Math.sqrt(1.5)) < 0.01);

  const soft = springSetup(100, undefined, SCALE);
  const stiff = springSetup(400, undefined, SCALE);
  assert.equal(stiff.kg, soft.kg);
  assert.equal(stiff.k, 400);
  assert.equal(stiff.kFrom, 'input');
  assert.equal(springSetup(undefined, 2, SCALE).kFrom, 'assumed');
  assert.ok(Math.abs(run(400, undefined, 40).period / run(100, undefined, 40).period - 0.5) < 0.01);
});

test('the default spring swings once in 2.5-3.5 s of real time (1x), lying or hanging, and a hanging one has room for its stretch', () => {
  const setup = springSetup(undefined, undefined, SCALE);
  const period = ((2 * Math.PI) / Math.sqrt(setup.omega2)) * STEP_S * SCALE.timeFactor;
  assert.ok(period >= MOTION_MIN_S && period <= MOTION_MAX_S, `lying: ${period.toFixed(3)} s`);
  // A hanging spring drawn 300 px long: the default size makes its stretch m·g/k a third of it.
  const ppm = springPxPerMeter(300, true)!;
  const hanging = scaleFor({ width: 960, height: 720, analysis: {} }, { spring: 300 }, 1, ppm);
  const h = springSetup(undefined, undefined, hanging, 300 / hanging.pxPerMeter);
  const hp = ((2 * Math.PI) / Math.sqrt(h.omega2)) * STEP_S * hanging.timeFactor;
  assert.ok(hp >= MOTION_MIN_S && hp <= MOTION_MAX_S, `hanging: ${hp.toFixed(3)} s`);
  const stretchPx = STEP_ACCEL / h.omega2;
  assert.ok(Math.abs(stretchPx / 300 - SPRING_SAG_SHARE) < 1e-6, `stretch ${stretchPx.toFixed(1)} px of 300`);
  // An entered 0.25 m hanging spring is stiffer, so its stretch still fits in it; an entered k is kept as it is.
  const short = scaleFor({ width: 960, height: 720, analysis: { annotations: [{ part: 'spring', quantity: 'length', value: 0.25, unit: 'm' }] } as never }, { spring: 300 });
  const s = springSetup(undefined, undefined, short, 0.25);
  assert.ok(Math.abs((STEP_ACCEL / s.omega2) / 300 - SPRING_SAG_SHARE) < 1e-6);
  assert.equal(springSetup(3, undefined, short, 0.25).k, 3);
});

// ---- The picture shows the whole swing (springView) -----------------------------------------------------------

const LIMITS = { arrowFraction: 0.22, minAspect: 0.45, maxAspect: 1.6 };
type Box = { x: number; y: number; w: number; h: number };
const holds = (v: Box, x0: number, y0: number, x1: number, y1: number) => x0 >= v.x && y0 >= v.y && x1 <= v.x + v.w && y1 <= v.y + v.h;

/** Every frame of the swing (block and longest arrow) inside the view, with the pads to spare. */
function swingFits(v: Box, block: Box, axis: { x: number; y: number }, eq: number, amp: number) {
  const lmax = LIMITS.arrowFraction * Math.min(v.w, v.h);
  for (let i = 0; i < 360; i++) {
    const th = (i * Math.PI) / 180;
    const u = eq + amp * Math.cos(th);
    const pad = BLOCK_PAD * v.w * 0.99;
    const bx = block.x + axis.x * u, by = block.y + axis.y * u;
    if (!holds(v, bx - pad, by - pad, bx + block.w + pad, by + block.h + pad)) return `block out at ${i}°`;
    // Arrow from the centre, as long as it gets: lmax at the middle of the swing.
    const len = lmax * Math.abs(Math.sin(th)), s = -Math.sign(Math.sin(th));
    const tx = block.x + block.w / 2 + axis.x * (u + s * len), ty = block.y + block.h / 2 + axis.y * (u + s * len);
    const ap = ARROW_PAD * v.w * 0.99;
    if (!holds(v, tx - ap * Math.abs(axis.x), ty - ap * Math.abs(axis.y), tx + ap * Math.abs(axis.x), ty + ap * Math.abs(axis.y))) return `arrow out at ${i}°`;
  }
  return null;
}

test('springView: a block swinging past the photo is shown whole at both turning points, with its arrow', () => {
  // Horizontal spring, the block drawn near the right edge of a 960 × 720 photo.
  const block = { x: 820, y: 300, w: 120, h: 110 };
  const axis = { x: 1, y: 0 };
  const v = springView({ photoW: 960, photoH: 720, block, axis, eq: 0, amp: 80 }, LIMITS);
  assert.ok(v, 'a view is needed');
  assert.equal(swingFits(v, block, axis, 0, 80), null);
  assert.ok(holds(v, 0, 0, 960, 720), 'the whole photo stays in the picture');
  // Wider, never lower than the photo: the picture's CSS height does not shrink.
  assert.ok(v.h / v.w >= 720 / 960 - 1e-9, `aspect ${v.h / v.w}`);
  // A few px past the block, not a big zoom-out.
  assert.ok(v.x + v.w - (block.x + block.w + 80) < 0.06 * v.w + LIMITS.arrowFraction * v.h, `right room ${v.x + v.w - (block.x + block.w + 80)}`);
});

test('springView: hanging spring under stronger gravity (rest moves down) and a block well inside the photo', () => {
  const block = { x: 420, y: 560, w: 100, h: 90 };
  const axis = { x: 0, y: 1 };
  const v = springView({ photoW: 960, photoH: 720, block, axis, eq: 60, amp: 70 }, LIMITS);
  assert.ok(v);
  assert.equal(swingFits(v, block, axis, 60, 70), null);
  assert.ok(v.h / v.w <= LIMITS.maxAspect + 1e-9);
  // Small swing in the middle of the photo: the photo as it is.
  assert.equal(springView({ photoW: 960, photoH: 720, block: { x: 430, y: 300, w: 100, h: 90 }, axis, eq: 0, amp: 30 }, LIMITS), null);
});

test('springView never shows less than before for the same photo, so a rebuild never shrinks the picture', () => {
  const block = { x: 820, y: 300, w: 120, h: 110 };
  const big = springView({ photoW: 960, photoH: 720, block, axis: { x: 1, y: 0 }, eq: 0, amp: 80 }, LIMITS)!;
  const small = springView({ photoW: 960, photoH: 720, block, axis: { x: 1, y: 0 }, eq: 0, amp: 20 }, LIMITS, big)!;
  assert.ok(holds(small, big.x, big.y, big.x + big.w, big.y + big.h));
  // The same swing again gives the same view (it holds still).
  const again = springView({ photoW: 960, photoH: 720, block, axis: { x: 1, y: 0 }, eq: 0, amp: 80 }, LIMITS, big)!;
  assert.ok(Math.abs(again.w - big.w) < 0.5 && Math.abs(again.h - big.h) < 0.5 && Math.abs(again.x - big.x) < 0.5 && Math.abs(again.y - big.y) < 0.5);
});

test('amplitude and middle of the swing stay put between gravity changes', () => {
  const setup = springSetup(undefined, undefined, SCALE);
  const osc = new SpringOscillator(setup.omega2, STEP_ACCEL, 40 * Math.sqrt(setup.omega2));
  const a0 = osc.amplitude();
  assert.ok(Math.abs(a0 - 40) < 1e-9);
  for (let i = 0; i < 2000; i++) {
    osc.step(STEP_ACCEL);
    assert.ok(Math.abs(osc.amplitude() - a0) < 1e-6 && Math.abs(osc.eq) < 1e-9);
  }
  osc.step(STEP_ACCEL * MOON);
  assert.ok(osc.eq < 0, 'Moon: the middle of the swing moves up (towards the fixed end)');
});
