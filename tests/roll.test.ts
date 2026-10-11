// A ball on the incline (src/scenes/roll.ts): what counts as round, and the rolling physics.
// Run: npm test
//
// Shapes are outlines as vision hands them over (hull points, working-image px). The ball drawn touching the slope
// loses its bottom to the slope's stroke (incline.ts splitBlocks), so a circle cut by a chord must still be round.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Point } from '../src/types.ts';
import { rollAccel, rollPath, rollPosition, rollStart, rollStep, roundness, SlopeAccelMeter, SOLID_BALL_K } from '../src/scenes/roll.ts';

const circle = (cx: number, cy: number, r: number, n = 48, wobble = 0): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const rr = r * (1 + wobble * Math.sin(5 * a + 1));
    return { x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) };
  });
const turn = (pts: Point[], a: number): Point[] => pts.map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
const box = (w: number, h: number): Point[] => [
  { x: -w / 2, y: -h / 2 },
  { x: w / 2, y: -h / 2 },
  { x: w / 2, y: h / 2 },
  { x: -w / 2, y: h / 2 },
];
/** Box with rounded corners (corner radius c), as a hand-drawn box often is. */
function roundedBox(w: number, h: number, c: number): Point[] {
  const out: Point[] = [];
  const corners: [number, number, number][] = [[w / 2 - c, h / 2 - c, 0], [-w / 2 + c, h / 2 - c, 90], [-w / 2 + c, -h / 2 + c, 180], [w / 2 - c, -h / 2 + c, 270]];
  for (const [cx, cy, a0] of corners)
    for (let d = 0; d <= 90; d += 15) {
      const a = ((a0 + d) * Math.PI) / 180;
      out.push({ x: cx + c * Math.cos(a), y: cy + c * Math.sin(a) });
    }
  return out;
}

test('round: a drawn circle, a wobbly one, one cut by the slope line, a filled disc outline', () => {
  for (const [name, pts] of [
    ['circle', circle(300, 200, 60)],
    ['wobbly circle (3 %)', circle(300, 200, 60, 48, 0.03)],
    ['circle missing its bottom 20 px (touching the slope)', circle(0, 0, 60, 60).filter((p) => p.y < 40)],
    ['circle missing its bottom 35 px', circle(0, 0, 60, 60).filter((p) => p.y < 25)],
    ['octagon-ish hull', circle(0, 0, 60, 8)],
  ] as const) {
    const r = roundness([...pts]);
    assert.ok(r?.round, `${name}: residual ${r?.residual.toFixed(3)}`);
  }
  // The fitted circle is the drawn one (centre and radius), also when its bottom is cut away.
  const cut = roundness(circle(500, 300, 70, 72).filter((p) => p.y < 300 + 45))!;
  assert.ok(Math.hypot(cut.circle.c.x - 500, cut.circle.c.y - 300) < 1 && Math.abs(cut.circle.r - 70) < 1);
});

test('not round: boxes (square, turned, long, rounded corners) and a triangle', () => {
  for (const [name, pts] of [
    ['square', box(100, 100)],
    ['square turned 30°', turn(box(100, 100), Math.PI / 6)],
    ['rectangle 1.4 : 1', box(140, 100)],
    ['box with rounded corners (15 %)', roundedBox(100, 100, 15)],
    ['box with rounded corners (25 %)', roundedBox(100, 100, 25)],
    ['triangle', circle(0, 0, 60, 3)],
  ] as const) {
    const r = roundness([...pts]);
    assert.ok(r && !r.round, `${name}: residual ${r?.residual.toFixed(3)}`);
  }
});

/** A 30° ramp going down to the right, its foot at (700, 500), floor y = 500, picture 1000 px wide; ball r = 40. */
function ramp(deg: number) {
  const th = (deg * Math.PI) / 180;
  const dir = { x: Math.cos(th), y: Math.sin(th) };
  const foot = { x: 700, y: 500 };
  const top = { x: foot.x - dir.x * 600, y: foot.y - dir.y * 600 };
  const normal = { x: dir.y, y: -dir.x };
  const r = 40;
  const start = { x: top.x + dir.x * 100 + normal.x * r, y: top.y + dir.y * 100 + normal.y * r };
  return { th, path: rollPath({ top, dir, normal, floorY: 500, start, r, width: 1000 }) };
}

const G = 0.001 * (1000 / 60) ** 2; // Matter's 9.8 m/s² in px per step²

test('rolls without slipping: a = 5/7 g sinθ, and it turns by distance / r', () => {
  for (const deg of [10, 30, 45]) {
    const { th, path } = ramp(deg);
    const st = rollStart(path);
    const meter = new SlopeAccelMeter();
    const p0 = rollPosition(path, st);
    let steps = 0;
    while (!st.onFloor && steps < 2000) {
      rollStep(path, st, { x: 0, y: G }, 0.3);
      if (st.onFloor) break;
      const p = rollPosition(path, st);
      meter.push((p.x - p0.x) * path.dir.x + (p.y - p0.y) * path.dir.y, G);
      assert.equal(st.slipping, false);
      // Rolled angle = distance / r (exactly: the contact point does not slide).
      assert.ok(Math.abs(st.turn - st.s / path.r) < 1e-9);
      steps++;
    }
    const want = (5 / 7) * G * Math.sin(th);
    const got = meter.value()!;
    assert.ok(Math.abs(got / want - 1) < 0.02, `${deg}°: measured ${got}, theory ${want}`);
    assert.ok(Math.abs(rollAccel(G, th, 0.3).a - want) < 1e-12);
  }
});

test('slides while turning when tanθ > 7/2 μ: a = g(sinθ − μcosθ), spin lags', () => {
  const { th, path } = ramp(45);
  const mu = 0.1; // tan 45° = 1 > 0.35
  const st = rollStart(path);
  const v: number[] = [];
  for (let i = 0; i < 40; i++) {
    rollStep(path, st, { x: 0, y: G }, mu);
    v.push(st.v);
    assert.equal(st.slipping, true);
    assert.ok(st.w < st.v);
  }
  const a = (v[v.length - 1] - v[0]) / (v.length - 1);
  assert.ok(Math.abs(a / (G * (Math.sin(th) - mu * Math.cos(th))) - 1) < 1e-9);
  // Spin grows from the friction torque: r·α = μ g cosθ / k.
  assert.ok(Math.abs(st.w - 40 * ((mu * G * Math.cos(th)) / SOLID_BALL_K)) < 1e-9);
});

test('at the foot it keeps rolling on the floor (angular momentum about the contact), then stops at the edge', () => {
  const { th, path } = ramp(30);
  const st = rollStart(path);
  let before = 0;
  while (!st.onFloor) {
    before = st.v;
    rollStep(path, st, { x: 0, y: G }, 0.3);
  }
  const k = SOLID_BALL_K;
  const expect = ((before + (5 / 7) * G * Math.sin(th)) * Math.cos(th) + k * (before + (5 / 7) * G * Math.sin(th))) / (1 + k);
  assert.ok(Math.abs(st.v - expect) < 1e-9, `after the foot ${st.v} vs ${expect}`);
  assert.equal(st.w, st.v);
  let n = 0;
  while (!st.stopped && n++ < 5000) rollStep(path, st, { x: 0, y: G }, 0.3);
  assert.equal(st.stopped, true);
  const end = rollPosition(path, st);
  assert.ok(Math.abs(end.x - (1000 - path.r)) < 1e-6 && Math.abs(end.y - (500 - path.r)) < 1e-6, `stopped at ${end.x}, ${end.y}`);
});

test('Moon gravity: the same roll, slower by g', () => {
  const { th, path } = ramp(30);
  const g = (G * 1.62) / 9.8;
  const st = rollStart(path);
  for (let i = 0; i < 20; i++) rollStep(path, st, { x: 0, y: g }, 0.3);
  assert.ok(Math.abs(st.v / (20 * (5 / 7) * g * Math.sin(th)) - 1) < 1e-9);
});
