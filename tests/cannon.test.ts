// The clean cannon's geometry (src/scenes/cannon.ts): the barrel found in the ink has its mouth at the ball, the mouth
// of the turned barrel is where the ball starts at an entered angle (same place as drawn at the drawn angle, on an arc
// about the pivot otherwise), and the turn to a new angle is eased over AIM_MS and survives a rebuild. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIM_MS, aimAngle, aimShown, aimTo, aimUnit, aiming, barrelOf, barrelOutline, mouthAt, PIVOT_SHARE } from '../src/scenes/cannon.ts';

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/** Ink of a barrel: a tube `len` long and `thick` across, ending `gap` short of the ball, along `deg` towards `facing`. */
function tubeInk(ball: { x: number; y: number }, deg: number, facing: 1 | -1, len: number, thick: number, gap: number) {
  const u = aimUnit(deg, facing);
  const n = { x: -u.y, y: u.x };
  const px: { x: number; y: number }[] = [];
  for (let t = -gap - len; t <= -gap; t += 1)
    for (const s of [-thick / 2, thick / 2]) px.push({ x: Math.round(ball.x + u.x * t + n.x * s), y: Math.round(ball.y + u.y * t + n.y * s) });
  return px;
}

test('barrelOf: mouth at the ball, pivot 35 % from the breech, the mouth of the drawn angle is the ball', () => {
  const ball = { x: 300, y: 200 }, r = 10;
  for (const facing of [1, -1] as const)
    for (const deg of [20, 45, 70]) {
      const u = aimUnit(deg, facing);
      const b = barrelOf(tubeInk(ball, deg, facing, 120, 30, 8), ball, u, r);
      assert.ok(b, `barrel found at ${deg}° facing ${facing}`);
      assert.ok(near(b.muzzle.x, ball.x) && near(b.muzzle.y, ball.y), 'the mouth is the ball');
      assert.ok(b.length > 120 && b.length < 140, `length ${b.length} covers the tube and the gap`);
      assert.ok(b.thickness >= 2 * r && b.thickness <= 34, `thickness ${b.thickness}`);
      const front = Math.hypot(b.muzzle.x - b.pivot.x, b.muzzle.y - b.pivot.y);
      assert.ok(near(front, (1 - PIVOT_SHARE) * b.length, 1e-6));
      const m = mouthAt(b.pivot, front, deg, facing);
      assert.ok(Math.hypot(m.x - ball.x, m.y - ball.y) < 1e-6, 'the mouth at the drawn angle is where the ball was drawn');
      // Turned: the mouth stays `front` from the pivot and points the entered way.
      const m2 = mouthAt(b.pivot, front, 60, facing);
      assert.ok(near(Math.hypot(m2.x - b.pivot.x, m2.y - b.pivot.y), front, 1e-6));
      const elev = (Math.atan2(-(m2.y - b.pivot.y), facing * (m2.x - b.pivot.x)) * 180) / Math.PI;
      assert.ok(near(elev, 60, 1e-6), `mouth elevation ${elev}`);
    }
});

test('barrelOf: no barrel for a ball with nothing behind it, a few scraps, or a line along one side (a cliff top)', () => {
  const ball = { x: 300, y: 200 }, r = 10;
  assert.equal(barrelOf([], ball, aimUnit(45, 1), r), null);
  const scraps = tubeInk(ball, 45, 1, 120, 30, 8).filter((_, i) => i % 40 === 0);
  assert.equal(barrelOf(scraps, ball, aimUnit(45, 1), r), null);
  // A ball on the top edge of a box, fired level: the edge runs behind the ball r below its centre, one side only.
  const edge: { x: number; y: number }[] = [];
  for (let x = 100; x <= 300; x++) for (let w = 0; w < 3; w++) edge.push({ x, y: 200 + r + w });
  for (let y = 200 + r; y <= 400; y++) for (let w = 0; w < 3; w++) edge.push({ x: 300 + w, y });
  assert.equal(barrelOf(edge, ball, aimUnit(0, 1), r), null);
  // The same box with the ball on its top right corner, fired at 28°: the top edge crosses the axis at a slant.
  const corner = edge.map((p) => ({ x: p.x, y: p.y }));
  assert.equal(barrelOf(corner, ball, aimUnit(28, 1), r), null);
});

test('barrelOf: the thickness comes from the front half, not the carriage under the back', () => {
  const ball = { x: 300, y: 200 }, r = 10;
  const ink = tubeInk(ball, 30, 1, 120, 26, 8);
  // A wheel's worth of ink under the back half, 2 r below the axis.
  const u = aimUnit(30, 1);
  for (let t = -120; t <= -70; t++) for (let s = 15; s <= 24; s++) ink.push({ x: Math.round(ball.x + u.x * t - u.y * s), y: Math.round(ball.y + u.y * t + u.x * s) });
  const b = barrelOf(ink, ball, u, r);
  assert.ok(b && b.thickness >= 24 && b.thickness <= 30, `thickness ${b?.thickness}`);
});

test('aim: a fresh drawing shows its angle at once; a change eases over AIM_MS; a rebuild keeps the turn', () => {
  const a0 = aimTo(undefined, 45, 1000);
  assert.equal(aimShown(a0, 1000), 45);
  assert.equal(aiming(a0, 1000), false);
  const a1 = aimTo(a0, 75, 2000);
  assert.equal(a1.from, 45);
  assert.equal(a1.to, 75);
  assert.equal(aimShown(a1, 2000), 45);
  assert.ok(aiming(a1, 2000 + AIM_MS / 2));
  const mid = aimShown(a1, 2000 + AIM_MS / 2);
  assert.ok(mid > 50 && mid < 70, `half way: ${mid}`);
  assert.equal(aimShown(a1, 2000 + AIM_MS), 75);
  assert.equal(aiming(a1, 2000 + AIM_MS), false);
  // Rebuilt for a slider while turning: the same turn goes on.
  assert.equal(aimTo(a1, 75, 2100), a1);
  // A new angle mid-turn starts from the angle shown then.
  const a2 = aimTo(a1, 15, 2000 + AIM_MS / 2);
  assert.ok(near(a2.from, mid));
  assert.equal(a2.to, 15);
});

test('aimAngle / barrelOutline: the outline turns with the angle and its mouth end is at front', () => {
  assert.ok(near(aimAngle(0, 1), 0) && near(aimAngle(90, 1), -Math.PI / 2) && near(aimAngle(0, -1), Math.PI));
  const pivot = { x: 100, y: 100 };
  const s = { front: 65, back: 35, thickness: 20 };
  for (const deg of [0, 45, 89]) {
    const o = barrelOutline(pivot, aimAngle(deg, 1), s);
    assert.equal(o.length, 8);
    const u = aimUnit(deg, 1);
    const along = o.map((p) => (p.x - pivot.x) * u.x + (p.y - pivot.y) * u.y);
    assert.ok(near(Math.max(...along), s.front, 1e-6), `mouth end at front for ${deg}°`);
    assert.ok(near(Math.min(...along), -s.back, 1e-6), `breech end at -back for ${deg}°`);
  }
});
