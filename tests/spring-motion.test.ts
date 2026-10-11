// Spring + mass motion (src/scenes/spring-motion.ts): the energy graph's Total stays flat and the period is 2π√(m/k),
// for any amplitude, k, m and gravity (Moon), with k and m set independently.
// Run: npm test
//
// Energies are worked out exactly as the graph does (graph.ts): KE = ½ m v² from the block's speed, PE = ½ k d² from
// its distance to the rest position, both in physical units through the drawing's scale (units.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowReach, defaultSpringK, SpringOscillator, springSetup, springTarget } from '../src/scenes/spring-motion.ts';
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

// ---- The picture shows the whole swing (springTarget) ---------------------------------------------------------

const ARROW = 0.22;
const BOUNDS = { min: 0.45, max: 1.6 };
const INSETS = { left: 20, right: 20, top: 66, bottom: 20 };
type Box = { x: number; y: number; w: number; h: number };
const spec = (photoW: number, photoH: number) => ({ photoW, photoH, cssW: 390, insets: INSETS, bounds: BOUNDS });

/**
 * Every frame of the swing inside the view's room (CSS px from each edge, the top row of buttons): the block, the
 * longest arrow's tip, the fixed end. Returns the smallest room left (CSS px), or a message when something is out.
 */
function swingRoom(v: Box, photo: { w: number; h: number }, block: Box, axis: { x: number; y: number }, eq: number, amp: number, anchor?: { x: number; y: number }) {
  const view = v ?? { x: 0, y: 0, w: photo.w, h: photo.h };
  const k = view.w / 390; // world px per CSS px
  const lmax = ARROW * Math.min(view.w, view.h);
  let least = Infinity;
  const room = (x: number, y: number) => {
    const l = (x - view.x) / k - INSETS.left + 20, r = (view.x + view.w - x) / k - INSETS.right + 20;
    const t = (y - view.y) / k - INSETS.top + 20, b = (view.y + view.h - y) / k - INSETS.bottom + 20;
    least = Math.min(least, l, r, t, b);
  };
  for (let i = 0; i < 360; i++) {
    const th = (i * Math.PI) / 180;
    const u = eq + amp * Math.cos(th);
    const bx = block.x + axis.x * u, by = block.y + axis.y * u;
    room(bx, by);
    room(bx + block.w, by + block.h);
    const len = lmax * Math.abs(Math.sin(th)), s = -Math.sign(Math.sin(th));
    room(block.x + block.w / 2 + axis.x * (u + s * len), block.y + block.h / 2 + axis.y * (u + s * len));
  }
  if (anchor) room(anchor.x, anchor.y);
  return least;
}

test('springTarget: a block swinging past the photo zooms out in the photo shape, everything 20 CSS px inside', () => {
  // Horizontal spring, the block drawn near the right edge of a 960 × 720 photo.
  const block = { x: 820, y: 300, w: 120, h: 110 };
  const axis = { x: 1, y: 0 };
  const v = springTarget(spec(960, 720), { block, axis, eq: 0, amp: 80 }, ARROW);
  assert.ok(v, 'a view is needed');
  assert.ok(Math.abs(v.h / v.w - 720 / 960) < 1e-9, `aspect ${v.h / v.w}`);
  assert.ok(v.w >= 960 - 1e-9, 'never zooms in');
  assert.ok(swingRoom(v, { w: 960, h: 720 }, block, axis, 0, 80) >= 20 - 1e-6);
});

test('springTarget: a hanging block sagging far (heavy, soft spring, strong gravity) keeps the picture height and the room', () => {
  const block = { x: 420, y: 500, w: 100, h: 90 };
  const axis = { x: 0, y: 1 };
  const anchor = { x: 470, y: 200 };
  for (const [eq, amp] of [[0, 30], [60, 70], [600, 650], [3000, 3020], [-900, 920]]) {
    const v = springTarget(spec(960, 1280), { block, axis, eq, amp, anchor }, ARROW);
    if (v) assert.ok(Math.abs(v.h / v.w - 1280 / 960) < 1e-9, `aspect ${v.h / v.w} at eq ${eq}`);
    const least = swingRoom(v!, { w: 960, h: 1280 }, block, axis, eq, amp, anchor);
    assert.ok(least >= 20 - 1e-6, `room ${least.toFixed(2)} CSS px at eq ${eq}`);
    if (v && v.w > 1.2 * 960) {
      // Zoomed out: the swing is in the middle of the room.
      const mid = block.y + block.h / 2 + eq;
      const roomMid = v.y + ((INSETS.top + (v.h * 390) / v.w - INSETS.bottom) / 2) * (v.w / 390);
      assert.ok(Math.abs(mid - roomMid) < 0.1 * v.h + 300, `centre ${mid} vs ${roomMid}`);
    }
  }
  // A small swing in the middle of the photo: the photo as it is.
  assert.equal(springTarget(spec(960, 1280), { block: { x: 430, y: 500, w: 100, h: 90 }, axis, eq: 0, amp: 30 }, ARROW), null);
});

test('springTarget: the same swing gives the same view (the camera holds still)', () => {
  const r = { block: { x: 820, y: 300, w: 120, h: 110 }, axis: { x: 0, y: 1 }, eq: 400, amp: 420 };
  const a = springTarget(spec(960, 720), r, ARROW)!;
  const b = springTarget(spec(960, 720), { ...r, amp: r.amp + 1e-9 }, ARROW)!;
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.w - b.w) < 1e-6);
});

test('arrowReach: the arrow tip (as vectors.ts scales it) stays within the reach, also right after a gravity change', () => {
  const omega = 0.05, lmax = 120;
  // Gravity changed with the block at d0 from the new middle, moving at v0; the arrows were scaled to vSeen so far.
  for (const [d0, v0, vSeen] of [[300, 2, 0.5], [300, 2, 30], [-300, -2, 1], [300, -2, 1], [0, 4, 4], [10, 0.1, 0.05], [200, 0, 1]]) {
    const amp = Math.hypot(d0, v0 / omega);
    const reach = arrowReach(amp, lmax, 0, { u: d0, v: v0, vSeen, omega });
    // Run the swing (two periods) and the arrow scale: k ≤ lmax / max(seen, now), seen only grows.
    let seen = Math.max(0.9 * vSeen, Math.abs(v0)), u = d0, v = v0, worst = 0;
    for (let i = 0; i < Math.round((4 * Math.PI) / omega); i++) {
      const c = Math.cos(omega), sn = Math.sin(omega);
      [u, v] = [u * c + (v / omega) * sn, -u * omega * sn + v * c];
      seen = Math.max(seen, Math.abs(v));
      const len = (lmax * Math.abs(v)) / seen;
      worst = Math.max(worst, Math.abs(u + Math.sign(v) * len));
    }
    // Half a px: the speeds are seen one step at a time, so the fastest seen can sit a hair under Aω.
    assert.ok(worst <= reach + 0.5, `d0 ${d0} v0 ${v0}: tip ${worst.toFixed(1)} > reach ${reach.toFixed(1)}`);
    assert.ok(reach <= amp + lmax + 1e-9);
  }
  // Without a start (or once the swing has been seen at full speed) it is the steady bound.
  assert.equal(arrowReach(300, lmax, 0), Math.hypot(300, lmax));
  assert.equal(arrowReach(300, lmax, 0, { u: 200, v: 3, vSeen: 340 * omega, omega }), Math.hypot(300, lmax));
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
