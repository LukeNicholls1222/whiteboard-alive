// Spring + mass motion (src/scenes/spring-motion.ts): the energy graph's Total stays flat and the period is 2π√(m/k),
// for any amplitude, k, m and gravity (Moon), with k and m set independently.
// Run: npm test
//
// Energies are worked out exactly as the graph does (graph.ts): KE = ½ m v² from the block's speed, PE = ½ k d² from
// its distance to the rest position, both in physical units through the drawing's scale (units.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSpringK, SpringOscillator, springSetup } from '../src/scenes/spring-motion.ts';
import { meters, mps, scaleFor, STEP_ACCEL, STEP_S } from '../src/units.ts';

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
  const k0 = defaultSpringK(SCALE);
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

test('the default spring swings about once a second on screen, as the tuned Matter spring did', () => {
  const setup = springSetup(undefined, undefined, SCALE);
  const screenPeriod = ((2 * Math.PI) / Math.sqrt(setup.omega2)) * STEP_S;
  assert.ok(screenPeriod > 0.95 && screenPeriod < 1.15, `screen period ${screenPeriod.toFixed(3)} s`);
});
