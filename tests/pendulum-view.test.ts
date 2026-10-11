// Pendulum view (src/scenes/pendulum-view.ts): the picture always holds the whole swing, the swing's range comes from
// the energy (not from where the bob is), the picture keeps the photo's shape, and the view eases without jumping.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsRect,
  easeRect,
  fitAspect,
  pendulumTarget,
  SmoothView,
  swingAmplitude,
  swingBox,
  unionRect,
} from '../src/scenes/pendulum-view.ts';
import { STEP_ACCEL } from '../src/units.ts';

const BOUNDS = { min: 0.45, max: 1.6 };
const deg = (d: number) => (d * Math.PI) / 180;
const close = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

/** Where the bob's disc (radius r) sits at angle th. */
const bobAt = (pivot: { x: number; y: number }, L: number, th: number) => ({ x: pivot.x + L * Math.sin(th), y: pivot.y + L * Math.cos(th) });

test('swingAmplitude: the energy gives the turning angle back, wherever the bob is on its path', () => {
  const L = 300, g = STEP_ACCEL;
  for (const a0 of [10, 30, 60, 120, 170]) {
    // Released from rest at a0: at any angle th on the way, ω follows from energy; the amplitude must still read a0.
    for (const th of [0, a0 / 3, a0 / 2, a0 * 0.9]) {
      const omega = Math.sqrt(Math.max(0, (2 * g * (Math.cos(deg(th)) - Math.cos(deg(a0)))) / L));
      close(swingAmplitude(L, deg(th), omega, g), deg(a0), 1e-9, `amplitude at ${th}° of a ${a0}° swing`);
    }
  }
  // Fast enough to go over the top, or no gravity: a full turn.
  assert.equal(swingAmplitude(L, 0, Math.sqrt((4 * g) / L) + 1e-6, g), Math.PI);
  assert.equal(swingAmplitude(L, deg(20), 0.01, 0), Math.PI);
});

test('swingAmplitude: the same speed at the bottom swings wider under the Moon (the view must grow)', () => {
  const L = 300, g = STEP_ACCEL;
  const omega = Math.sqrt((2 * g * (1 - Math.cos(deg(20)))) / L);
  close(swingAmplitude(L, 0, omega, g), deg(20), 1e-9, 'Earth');
  const moon = swingAmplitude(L, 0, omega, g * (1.62 / 9.8));
  assert.ok(moon > deg(45) && moon < deg(60), `Moon amplitude ${(moon * 180) / Math.PI}°`);
});

test('swingBox: holds the bob disc at every angle of the range, with the margin, and the pivot', () => {
  const pivot = { x: 400, y: 100 }, L = 350, r = 24;
  for (const ampDeg of [5, 40, 89, 95, 150, 180]) {
    const amp = deg(ampDeg);
    const box = swingBox({ pivot, length: L, bobRadius: r }, amp, 6);
    for (let k = -100; k <= 100; k++) {
      const th = (amp * k) / 100;
      const b = bobAt(pivot, L, th);
      assert.ok(containsRect(box, { x: b.x - r - 6, y: b.y - r - 6, w: 2 * (r + 6), h: 2 * (r + 6) }, 1e-9), `bob at ${(th * 180) / Math.PI}° of ±${ampDeg}°`);
    }
    assert.ok(containsRect(box, { x: pivot.x, y: pivot.y, w: 0, h: 0 }), 'pivot inside');
    // Not wastefully large: the box's half-width is the farthest reach plus the room.
    const reach = ampDeg >= 90 ? L : L * Math.sin(amp);
    close(box.w, 2 * (reach + r + 6), 1e-9, `width for ±${ampDeg}°`);
    close(box.y + box.h, pivot.y + L + r + 6, 1e-9, 'bottom = straight down + room');
  }
});

test('fitAspect / unionRect: the smallest rect of the asked shape around the box, grown evenly', () => {
  const u = unionRect({ x: 0, y: 0, w: 100, h: 80 }, { x: 90, y: 70, w: 30, h: 20 });
  assert.deepEqual(u, { x: 0, y: 0, w: 120, h: 90 });
  const wide = fitAspect({ x: 0, y: 0, w: 100, h: 80 }, 0.5); // wants h/w = 0.5: taller than that -> widen
  close(wide.h / wide.w, 0.5, 1e-12, 'aspect');
  assert.deepEqual(wide, { x: -30, y: 0, w: 160, h: 80 });
  const tall = fitAspect({ x: 0, y: 0, w: 100, h: 80 }, 1.2);
  close(tall.h / tall.w, 1.2, 1e-12, 'aspect');
  assert.deepEqual(tall, { x: 0, y: -20, w: 100, h: 120 });
});

test('pendulumTarget: the photo while the swing fits, else both in the photo shape (CSS height unchanged)', () => {
  const W = 960, H = 720;
  assert.equal(pendulumTarget(W, H, { x: 100, y: 50, w: 400, h: 500 }, BOUNDS), null);
  // Swing dips 60 px below the photo: the view is taller, and widened to keep 720 / 960.
  const v = pendulumTarget(W, H, { x: 300, y: 50, w: 400, h: 730 }, BOUNDS)!;
  assert.ok(v, 'a view');
  close(v.h / v.w, H / W, 1e-12, 'photo shape kept');
  assert.ok(containsRect(v, { x: 0, y: 0, w: W, h: H }, 1e-9), 'whole photo shown');
  assert.ok(containsRect(v, { x: 300, y: 50, w: 400, h: 730 }, 1e-9), 'whole swing shown');
  close(v.h, 780, 1e-9, 'as tall as needed, no more');
  // A bob swinging past the right edge: wider, and taller by the same shape.
  const s = pendulumTarget(W, H, { x: 500, y: 50, w: 600, h: 500 }, BOUNDS)!;
  close(s.h / s.w, H / W, 1e-12, 'photo shape kept');
  close(s.w, 1100, 1e-9, 'as wide as needed');
  // A very tall photo is clamped to what sim.ts allows.
  const t = pendulumTarget(400, 800, { x: -10, y: 0, w: 100, h: 100 }, BOUNDS)!;
  close(t.h / t.w, 1.6, 1e-12, 'clamped shape');
});

test('SmoothView: shows its first target at once, glides to a new one in about 0.4 s, and is the photo again when back', () => {
  const sv = new SmoothView(960, 720);
  assert.equal(sv.read(null, 0), null);
  const target = { x: -100, y: -75, w: 1160, h: 870 };
  let v = sv.read(target, 0.016)!;
  // Just after a change: barely moved (no jump).
  assert.ok(v.w < 960 + 0.2 * 200, `no jump: ${v.w}`);
  let maxStep = 0, prev = v.w;
  for (let t = 0.032; t <= 0.45; t += 0.016) {
    v = sv.read(target, t)!;
    maxStep = Math.max(maxStep, v.w - prev);
    prev = v.w;
  }
  assert.ok(maxStep < 30, `at most ${maxStep} px a frame`);
  close(v.w, 1160, 3, 'nearly there after 0.45 s');
  close(v.h / v.w, 0.75, 1e-9, 'shape kept while gliding');
  for (let t = 0.46; t <= 0.7; t += 0.016) v = sv.read(target, t)!;
  assert.deepEqual(v, target, 'settled by 0.7 s');
  // Read twice in the same frame: no extra movement.
  const a = sv.read(target, 0.75), b = sv.read(target, 0.75);
  assert.deepEqual(a, b);
  // Back to the photo: glides, then null.
  let out: ReturnType<typeof sv.read> = v;
  for (let t = 0.77; t <= 1.5; t += 0.016) out = sv.read(null, t);
  assert.equal(out, null);
});

test('easeRect: moves a fixed share of the way per time constant, never past the target', () => {
  const from = { x: 0, y: 0, w: 100, h: 100 }, to = { x: 10, y: 20, w: 200, h: 300 };
  const r = easeRect(from, to, 0.12, 0.12);
  close(r.w, 100 + 100 * (1 - Math.exp(-1)), 1e-9, 'one τ');
  const far = easeRect(from, to, 10, 0.12);
  close(far.w, 200, 1e-3, 'settles');
  assert.deepEqual(easeRect(from, to, 0, 0.12), from);
});
