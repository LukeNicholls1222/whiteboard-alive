// Seesaw / lever: finding the pivot, plank and weights from the ink (src/scenes/lever-plan.ts), the offline guess
// (src/guess.ts) and the motion (θ'' = τ / I). Run: npm test
//
// Ink of samples/generated/lever-gen-01..03 (vision output, tests/fixtures), plus drawings built at the ink level (no
// images): ramps that must stay inclines, and a plain seesaw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { balanceOf, findLever, floorLimits, HOLD_STEPS, imbalance, leverInertia, leverTorque, LeverMotion, riding, rodInertia, type LeverModel } from '../src/scenes/lever-plan.ts';
import { guessDiagram } from '../src/guess.ts';
import { parseVoice } from '../src/voice.ts';

type Pt = [number, number];

class Paper {
  W: number;
  H: number;
  pen: number;
  ink: Uint8Array;
  constructor(W = 960, H = 720, pen = 9) {
    this.W = W;
    this.H = H;
    this.pen = pen;
    this.ink = new Uint8Array(W * H);
  }
  line([x0, y0]: Pt, [x1, y1]: Pt) {
    const r = this.pen / 2, L = Math.hypot(x1 - x0, y1 - y0) || 1;
    for (let y = Math.floor(Math.min(y0, y1) - r); y <= Math.ceil(Math.max(y0, y1) + r); y++)
      for (let x = Math.floor(Math.min(x0, x1) - r); x <= Math.ceil(Math.max(x0, x1) + r); x++) {
        if (x < 0 || y < 0 || x >= this.W || y >= this.H) continue;
        const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / (L * L)));
        if (Math.hypot(x - x0 - t * (x1 - x0), y - y0 - t * (y1 - y0)) <= r) this.ink[y * this.W + x] = 255;
      }
    return this;
  }
  path(...p: Pt[]) {
    for (let i = 1; i < p.length; i++) this.line(p[i - 1], p[i]);
    return this;
  }
  /** A box standing on y = bottom, rotated by `deg` about its bottom-middle (on a slope). */
  box(cx: number, bottom: number, w: number, h: number, deg = 0) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const at = (u: number, v: number): Pt => [cx + u * c - v * s, bottom + u * s + v * c];
    return this.path(at(-w / 2, 0), at(-w / 2, -h), at(w / 2, -h), at(w / 2, 0), at(-w / 2, 0));
  }
}

function fixture(name: string) {
  const dir = name.includes('lever') ? './fixtures/lever/' : './fixtures/';
  const d = JSON.parse(readFileSync(new URL(`${dir}${name}.ink.json`, import.meta.url), 'utf8'));
  const bits = inflateSync(Buffer.from(d.inkBitsDeflate, 'base64'));
  const ink = new Uint8Array(d.width * d.height);
  for (let i = 0; i < ink.length; i++) if (bits[i >> 3] & (1 << (i & 7))) ink[i] = 255;
  return { ink, W: d.width as number, H: d.height as number };
}

const guess = (ink: Uint8Array, W: number, H: number) => guessDiagram({ width: W, height: H, ink, contours: [] });

// ---- Finding it ---------------------------------------------------------------------------------------------------

test('lever-gen-01: centred pivot, big box left, small box right; guessed as a lever', () => {
  const { ink, W, H } = fixture('lever-gen-01');
  const f = findLever(ink, W, H);
  assert.ok(f, 'no lever found');
  assert.ok(Math.abs(f.pivot.x - 473) < 12 && Math.abs(f.pivot.y - 416) < 12, `pivot ${JSON.stringify(f.pivot)}`);
  assert.ok(Math.abs(f.deg) <= 2);
  assert.ok(f.left && f.right, 'two weights');
  assert.ok(f.left.area > 3 * f.right.area, 'left box is much bigger');
  assert.equal(guess(ink, W, H).diagram, 'lever');
});

test('lever-gen-02: plank as one line, pivot to the left, a box only on the right end', () => {
  const { ink, W, H } = fixture('lever-gen-02');
  const f = findLever(ink, W, H);
  assert.ok(f, 'no lever found');
  assert.equal(f.left, null);
  assert.ok(f.right && f.right.u1 > 0.9 * f.uMax, 'box at the right end');
  assert.ok(-f.uMin < 0.4 * f.uMax, 'pivot near the left');
  assert.equal(guess(ink, W, H).diagram, 'lever');
});

test('lever-gen-03: two boxes of about the same size at about the same distance', () => {
  const { ink, W, H } = fixture('lever-gen-03');
  const f = findLever(ink, W, H);
  assert.ok(f && f.left && f.right, 'two weights');
  const mdL = f.left.area * -(f.left.u0 + f.left.u1) / 2, mdR = f.right.area * (f.right.u0 + f.right.u1) / 2;
  assert.ok(Math.abs(mdL - mdR) / Math.max(mdL, mdR) < 0.12, `moments ${mdL} vs ${mdR}`);
  assert.equal(guess(ink, W, H).diagram, 'lever');
});

test('judge-lever-02: thick marker triangle under a slightly tilted plank, hand shadow; guessed as a lever', () => {
  // The triangle's sides bulge ~12% of its width near the tip (thick marker): still a pivot.
  const { ink, W, H } = fixture('judge-lever-02');
  const f = findLever(ink, W, H);
  assert.ok(f, 'no lever found');
  assert.ok(Math.abs(f.pivot.x - 506) < 12 && Math.abs(f.pivot.y - 338) < 12, `pivot ${JSON.stringify(f.pivot)}`);
  assert.ok(f.left && f.right, 'two weights');
  assert.ok(f.left.area > 3 * f.right.area, 'left box is much bigger');
  assert.equal(guess(ink, W, H).diagram, 'lever');
});

test('spring samples are never levers', () => {
  for (const n of ['01', '02', '03', '04', '05', '06']) {
    const { ink, W, H } = fixture(`spring-gen-${n}`);
    assert.equal(findLever(ink, W, H), null, `spring-gen-${n}`);
  }
});

test('ramps stay inclines: right triangle with a block on the slope, ground line, steep and shallow', () => {
  for (const [rise, side] of [[300, 'right'], [140, 'right'], [200, 'left']] as const) {
    const p = new Paper();
    const x0 = 180, x1 = 760, y = 600;
    const top: Pt = side === 'right' ? [x1, y - rise] : [x0, y - rise];
    p.path([x0, y], [x1, y], top, [x0, y]);
    p.line([40, y], [920, y]); // ground line running past both ends
    const deg = (Math.atan2(rise, x1 - x0) * 180) / Math.PI * (side === 'right' ? -1 : 1);
    const mid = side === 'right' ? 0.55 : 0.45;
    const bx = x0 + (x1 - x0) * mid;
    const by = side === 'right' ? y - rise * mid : y - rise * (1 - mid);
    p.box(bx, by - 5, 90, 70, deg);
    assert.equal(findLever(p.ink, p.W, p.H), null, `rise ${rise} ${side}`);
    assert.equal(guess(p.ink, p.W, p.H).diagram, 'incline', `rise ${rise} ${side}`);
  }
});

test('a drawn seesaw: line plank on a triangle, a box on each side', () => {
  const p = new Paper();
  p.path([400, 600], [480, 450], [560, 600], [400, 600]);
  p.line([150, 446], [820, 446]);
  p.box(230, 441, 100, 90);
  p.box(740, 441, 70, 60);
  const f = findLever(p.ink, p.W, p.H);
  assert.ok(f && f.left && f.right);
  assert.ok(Math.abs(f.pivot.x - 480) < 6, `pivot ${f.pivot.x}`);
  assert.ok(Math.abs(f.uMin + 330) < 10 && Math.abs(f.uMax - 340) < 10, `ends ${f.uMin} ${f.uMax}`);
  assert.equal(guess(p.ink, p.W, p.H).diagram, 'lever');
});

// ---- Motion -------------------------------------------------------------------------------------------------------

const model = (mL: number, dL: number, mR: number, dR: number): LeverModel => ({
  items: [
    { m: mL, u: -dL, v: -30 },
    { m: mR, u: dR, v: -30 },
  ],
  plankI: rodInertia(0.15 * (mL + mR), -300, 300),
  ...floorLimits(-300, 300, 100),
});

test('initial angular acceleration is τ / I (within 1%), measured from where the weight goes', () => {
  const g = 0.278; // Earth gravity in px per step² (Matter)
  const m = model(3, 200, 1, 250);
  const tau = leverTorque(m, 0, g); // = g (−3·200 + 1·250) = −350 g
  assert.ok(Math.abs(tau - g * (-600 + 250)) < 1e-9);
  const expected = tau / leverInertia(m);
  const motion = new LeverMotion(m, 0, false);
  const k = 3;
  for (let i = 0; i < k; i++) motion.step(g);
  // Where the right weight is now (pivot at the origin), its angle about the pivot against where it started.
  const { u, v } = m.items[1];
  const x = u * Math.cos(motion.theta) - v * Math.sin(motion.theta), y = u * Math.sin(motion.theta) + v * Math.cos(motion.theta);
  const turned = Math.atan2(y, x) - Math.atan2(v, u);
  const measured = (2 * turned) / (k * (k + 1)); // semi-implicit Euler from rest: θ_k = α k (k + 1) / 2
  assert.ok(Math.abs(measured - expected) / Math.abs(expected) < 0.01, `α ${measured} vs τ/I ${expected}`);
});

test('balanced (m₁d₁ = m₂d₂): no torque, it never tips (rocks a little about level)', () => {
  const g = 0.278;
  const m = model(2, 150, 1, 300);
  assert.equal(imbalance(m), 0);
  assert.equal(leverTorque(m, 0, g), 0);
  const motion = new LeverMotion(m, 0, true);
  let maxAbs = 0;
  for (let i = 0; i < 1200; i++) {
    motion.step(g);
    maxAbs = Math.max(maxAbs, Math.abs(motion.theta));
  }
  assert.ok(maxAbs > 0, 'it moves a little (never frozen)');
  assert.ok(maxAbs < (3 * Math.PI) / 180, `stays within 3° (${(maxAbs * 180) / Math.PI}°)`);
  assert.ok(motion.theta < m.thetaMax && motion.theta > m.thetaMin);
});

test('balanced only when typed values match; drawn sizes within 12% are "nearly balanced" and tilt a little', () => {
  assert.deepEqual(balanceOf(0, true), { balanced: true, nearly: false, settle: 0 });
  assert.equal(balanceOf(0.05, true).balanced, false, 'typed values 5% apart tip');
  const n = balanceOf(-0.11, false); // lever-gen-03: 3.30 vs 2.96 N·m, left heavier
  assert.ok(n.balanced && n.nearly);
  assert.ok(n.settle < 0 && n.settle > (-3.01 * Math.PI) / 180, `settle ${n.settle}`);
  assert.ok(Math.abs(balanceOf(0.04, false).settle) < Math.abs(balanceOf(0.08, false).settle), 'bigger difference, bigger tilt');
  assert.equal(balanceOf(0.2, false).balanced, false, 'far apart: tips');
  assert.equal(balanceOf(0, false, false).balanced, false, 'one weight: tips');

  // It settles at the small tilt, toward the heavier (left) side, and never reaches the floor.
  const m = model(2.2, 150, 1, 300);
  const motion = new LeverMotion(m, 0, true, n.settle);
  let lowest = 0;
  for (let i = 0; i < 1200; i++) {
    motion.step(0.278);
    lowest = Math.min(lowest, motion.theta);
    assert.ok(motion.theta > m.thetaMin + 0.01 && motion.theta < m.thetaMax, 'never down to the floor');
  }
  assert.ok(Math.abs(motion.theta - n.settle) < (1.5 * Math.PI) / 180, `rests near the tilt (${motion.theta} vs ${n.settle})`);
  assert.ok(lowest < 0, 'tilts left');
});

test('weights ride on the plank: same spot in its frame at every angle, velocity = ω × r', () => {
  const P = { x: 400, y: 300 };
  const u = -180, v = -45, omega = 0.013;
  for (const th of [-0.36, -0.1, 0, 0.2, 0.36]) {
    const a = riding(P, u, v, th, omega), b = riding(P, u, v, th + omega, omega);
    // Back in the plank frame: exactly (u, v).
    const dx = a.at.x - P.x, dy = a.at.y - P.y, c = Math.cos(th), s = Math.sin(th);
    assert.ok(Math.abs(dx * c + dy * s - u) < 1e-9 && Math.abs(-dx * s + dy * c - v) < 1e-9);
    // One step later it has moved by its velocity (to first order).
    assert.ok(Math.hypot(b.at.x - a.at.x - a.vel.x, b.at.y - a.at.y - a.vel.y) < 0.01 * Math.hypot(a.vel.x, a.vel.y));
  }
});

test('the heavier side goes down to the floor and rests there, then replays', () => {
  const g = 0.278;
  for (const [mL, mR, sign] of [[1, 3, 1], [4, 1, -1]] as const) {
    const m = model(mL, 200, mR, 200);
    const motion = new LeverMotion(m, 0, false);
    let steps = 0;
    while (motion.hold === 0 && steps < 2000) {
      motion.step(g);
      steps++;
      assert.ok(Math.sign(motion.theta) === sign || motion.theta === 0, 'never goes the wrong way');
    }
    assert.ok(motion.hold > 0, 'came to rest');
    assert.equal(motion.theta, sign > 0 ? m.thetaMax : m.thetaMin, 'resting on the floor');
    for (let i = 0; i < HOLD_STEPS; i++) motion.step(g);
    assert.ok(motion.hold === 0 && motion.theta === 0, 'replayed from level after the hold');
  }
});

// ---- Voice --------------------------------------------------------------------------------------------------------

test('voice on a seesaw: masses and distances by side', () => {
  const ctx = {
    targets: [
      { key: 'gravity' as const, value: 9.8, min: 0, max: 25 },
      { key: 'leftMass' as const, value: 2, min: 0.001, max: 1000 },
      { key: 'rightMass' as const, value: 1, min: 0.001, max: 1000 },
      { key: 'leftDistance' as const, value: 0.3, min: 0.001, max: 1000 },
      { key: 'rightDistance' as const, value: 0.2, min: 0.001, max: 1000 },
    ],
    air: false,
    numbers: true,
  };
  const set = (s: string) => parseVoice(s, ctx).set;
  assert.deepEqual(set('left weight 3 kilograms'), { leftMass: 3 });
  assert.deepEqual(set('move the right weight further'), { rightDistance: 0.3 });
  assert.deepEqual(set('move the left weight closer'), { leftDistance: 0.2 });
  assert.deepEqual(set('right distance 30 centimeters'), { rightDistance: 0.3 });
  assert.deepEqual(set('left 50 cm'), { leftDistance: 0.5 });
  assert.deepEqual(set('make the left weight heavier'), { leftMass: 4 });
  assert.deepEqual(set('right weight 2 kilograms and left distance 1 meter'), { rightMass: 2, leftDistance: 1 });
  assert.ok(parseVoice('30 centimeters', ctx).problems.length, 'asks which weight');
});
