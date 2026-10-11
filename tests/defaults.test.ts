// Default values (src/defaults.ts): with nothing entered, one motion takes 2.5-3.5 s of real time, with the textbook
// physics unchanged (g = 9.8 m/s², real time); an entered length still sets the scale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLISION_SPEED,
  collisionPxPerMeter,
  collisionSpeedFactor,
  fallPxPerMeter,
  flightSteps,
  leverPxPerMeter,
  MOTION_MAX_S,
  MOTION_MIN_S,
  PENDULUM_L_M,
  pendulumPxPerMeter,
  PULLEY_MASS_RATIO,
  pulleyMasses,
  pulleyPxPerMeter,
  pxPerMeterForSteps,
  rollPxPerMeter,
  rollSteps,
  slideSteps,
  SPRING_K,
  TARGET_S,
} from '../src/defaults.ts';
import { EARTH_G, STEP_ACCEL, STEP_S, mps, scaleFor } from '../src/units.ts';

const paper = (ppm: number | undefined, measures = {}, gravityScale = 1, annotations: unknown[] = []) =>
  scaleFor({ width: 960, height: 720, analysis: { annotations } as never }, measures, gravityScale, ppm);
/** Real seconds `steps` physics steps take at this scale. */
const real = (steps: number, s: { timeFactor: number }) => steps * STEP_S * s.timeFactor;
const inRange = (t: number, what: string) => assert.ok(t >= MOTION_MIN_S && t <= MOTION_MAX_S, `${what}: ${t.toFixed(3)} s`);

test('pxPerMeterForSteps: those steps take TARGET_S of real time, at any gravityScale', () => {
  for (const steps of [40, 91, 400]) {
    for (const gs of [1, 0.3]) {
      const s = paper(pxPerMeterForSteps(steps, gs), {}, gs);
      assert.ok(Math.abs(real(steps, s) - TARGET_S) < 1e-9, `${steps} steps, gs ${gs}: ${real(steps, s)}`);
    }
  }
  assert.equal(pxPerMeterForSteps(0), undefined);
});

test('an entered length sets the scale, the default only applies without one', () => {
  const ppm = pendulumPxPerMeter(400);
  const s = paper(ppm, { string: 400 }, 1, [{ part: 'string', quantity: 'length', value: 0.25, unit: 'm', text: '0.25 m' }]);
  assert.equal(s.pxPerMeter, 1600);
  assert.equal(paper(ppm, { string: 400 }).pxPerMeter, 400 / PENDULUM_L_M);
  assert.equal(paper(undefined).pxPerMeter, 960);
});

test('pendulum and spring defaults: one period in range', () => {
  inRange(2 * Math.PI * Math.sqrt(PENDULUM_L_M / EARTH_G), 'pendulum 2π√(L/g)');
  inRange(2 * Math.PI * Math.sqrt(1 / SPRING_K), 'spring 2π√(m/k)');
});

test('slideSteps: the textbook slide down a slope, then the floor', () => {
  const th = (30 * Math.PI) / 180;
  // Frictionless from rest, no floor: s = ½ g sinθ t².
  assert.ok(Math.abs(slideSteps(400, th, 0, 0, 0) - Math.sqrt((2 * 400) / (STEP_ACCEL * Math.sin(th)))) < 1e-9);
  // With friction and a long floor: down the slope, then v cosθ / (μ g) on the floor.
  const mu = 0.3, a = STEP_ACCEL * (Math.sin(th) - mu * Math.cos(th));
  const t1 = Math.sqrt((2 * 400) / a), v = a * t1;
  assert.ok(Math.abs(slideSteps(400, th, mu, 0, 1e6) - (t1 + (v * Math.cos(th)) / (mu * STEP_ACCEL))) < 1e-6);
  // Friction holds (gentle slope): the push runs out, t = v₀ / decel.
  const g10 = (10 * Math.PI) / 180, dec = STEP_ACCEL * (mu * Math.cos(g10) - Math.sin(g10));
  assert.ok(Math.abs(slideSteps(400, g10, mu, 2, 0) - 2 / dec) < 1e-9);
  // A ramp sized by it takes TARGET_S.
  const steps = slideSteps(355, th, mu, 0.6, 0);
  inRange(real(steps, paper(pxPerMeterForSteps(steps))), 'ramp');
});

test('rolling ball: the whole run takes TARGET_S unless the slope alone would be under 2.6 s', () => {
  const a = (STEP_ACCEL * Math.sin(0.66)) / 1.4;
  const short = rollSteps(500, a, 50);
  const s1 = paper(rollPxPerMeter(short));
  inRange(real(short.total, s1), 'roll, short floor');
  const long = rollSteps(300, a, 600);
  const s2 = paper(rollPxPerMeter(long));
  assert.ok(real(long.slope, s2) >= 2.6 - 1e-9 && real(long.total, s2) > TARGET_S);
});

test('launch: the fitted shot flies TARGET_S', () => {
  const steps = flightSteps(9, Math.sin(0.5), 120);
  const s = paper(pxPerMeterForSteps(steps));
  inRange(real(steps, s), 'flight');
});

test('pulley: default weights 1 : PULLEY_MASS_RATIO, the bigger drawing heavier; the fall takes TARGET_S', () => {
  assert.deepEqual(pulleyMasses(5000, 2000), [PULLEY_MASS_RATIO, 1]);
  assert.deepEqual(pulleyMasses(2000, 5000), [1, PULLEY_MASS_RATIO]);
  const aRel = (PULLEY_MASS_RATIO - 1) / (PULLEY_MASS_RATIO + 1);
  const ppm = pulleyPxPerMeter(300, aRel)!;
  // s = ½ g aRel t²
  inRange(Math.sqrt((2 * (300 / ppm)) / (EARTH_G * aRel)), 'pulley');
});

test('seesaw: the tip is TARGET_S / LEVER_SETTLE, the bounces fill the rest', () => {
  const alpha = 2e-5, travel = 0.2;
  const s = paper(leverPxPerMeter(travel, alpha));
  const tip = real(Math.sqrt((2 * travel) / alpha), s);
  assert.ok(tip > 1.5 && tip < TARGET_S, `tip ${tip}`);
});

test('collision: the arrows keep their ratio, slowed so the first hit comes TARGET_S after the start', () => {
  const tf = paper(undefined).timeFactor;
  const k = collisionSpeedFactor(35, tf);
  // The first hit is 35 steps away at the drawn speeds: at k times those speeds it is 35 / k steps away.
  assert.ok(Math.abs(real(35 / k, paper(undefined)) - TARGET_S) < 1e-9);
  assert.equal(collisionSpeedFactor(null, tf), 1);
  // Sized by collisionPxPerMeter: the faster ball (3 px per step at the drawn speed) rolls at COLLISION_SPEED.
  const s = paper(collisionPxPerMeter(3, 35));
  const k2 = collisionSpeedFactor(35, s.timeFactor);
  assert.ok(Math.abs(mps(3 * k2, s) - COLLISION_SPEED) < 1e-9);
  assert.ok(Math.abs(real(35 / k2, s) - TARGET_S) < 1e-9);
});

test('falling objects: the run takes TARGET_S, the fall itself at least 1 s', () => {
  inRange(real(150, paper(fallPxPerMeter(150, 70))), 'run');
  // A long settle after a short fall: the fall gets its second, the run is longer.
  const s = paper(fallPxPerMeter(400, 60));
  assert.ok(Math.abs(real(60, s) - 1) < 1e-9 && real(400, s) > TARGET_S);
});

test('Launch: an entered speed, height or angle sizes the paper about real size, pulled back only for a big shot', async () => {
  const { launchPxPerMeter } = await import('../src/defaults.ts');
  const room = { paperPpm: 960, fitPx: 5, heightPx: 100, rangePx: 400, topPx: 500 };
  // 2 m/s at 75° from the ground: a paper of 1 m (a cannon of tens of cm), not the 3 s default of over 100 m.
  assert.equal(launchPxPerMeter({ ...room, speedMps: 2, elevDeg: 75, heightM: 0 }), 960);
  // 18 m/s flies about 33 m: the paper grows until the arc fits the room (range ≤ 400 px, top ≤ 500 px).
  const big = launchPxPerMeter({ ...room, speedMps: 18, elevDeg: 45, heightM: 0 });
  const rangeM = (18 * 18) / 9.8;
  assert.ok(big < 960 && rangeM * big <= 400 * 1.001 && rangeM * big > 300, `ppm ${big}`);
  // A tall entered height alone: the pillar fits the room.
  const tall = launchPxPerMeter({ ...room, elevDeg: 60, heightM: 50 });
  assert.ok(tall * 50 <= 500, `ppm ${tall}`);
  // Only an angle (the fitted speed, the drawn height): nothing depends on the scale, the paper is 1 m.
  assert.equal(launchPxPerMeter({ ...room, elevDeg: 80 }), 960);
});
