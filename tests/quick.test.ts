// The number pills under the picture (src/quick.ts): names, − / + steps and the slider scale, for every box
// fieldsFor() can make. Placeholders carry the value only (no "assumed" / "drawn"). Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_SPECS, enterPair, fieldsFor, type EntryKey } from '../src/entries.ts';
import { niceSliderValue, nudge, shortLabel, showValue, sliderScale, stepAt } from '../src/quick.ts';

const spec = (key: EntryKey, extra = {}) => ({ ...ENTRY_SPECS[key], placeholder: '', ...extra });

test('pill names are short and generic (labels added later get one too)', () => {
  assert.equal(shortLabel(spec('stringLength')), 'Length');
  assert.equal(shortLabel(spec('bobMass')), 'Mass');
  assert.equal(shortLabel(spec('springK')), 'Spring');
  assert.equal(shortLabel(spec('rampAngle')), 'Angle');
  assert.equal(shortLabel(spec('launchSpeed')), 'Speed');
  assert.equal(shortLabel(spec('leftBallMass')), 'Left');
  assert.equal(shortLabel(spec('rightDistance')), 'Right');
  assert.equal(shortLabel({ key: 'launchHeight' as EntryKey, label: 'Launch height' }), 'Height');
});

test('− / + step to the next round value in that direction', () => {
  const L = spec('stringLength');
  assert.equal(nudge(L, 0.429, 1), 0.45);
  assert.equal(nudge(L, 0.429, -1), 0.4);
  assert.equal(nudge(L, 1, -1), 0.95);
  const m = spec('bobMass');
  assert.equal(nudge(m, 1, 1), 1.5);
  assert.equal(nudge(m, 2.76, 1), 3);
  assert.equal(nudge(spec('rampAngle'), 31, 1), 32);
  const v = spec('leftSpeed');
  assert.equal(nudge(v, 0.927, 1), 1);
  assert.equal(nudge(v, 0, -1), -0.1);
  assert.equal(nudge(v, -0.959, 1), -0.9);
  assert.equal(stepAt(spec('launchSpeed'), 3, 1), 0.5);
});

test('steps stay inside the range, and inside what fits the drawing', () => {
  assert.equal(nudge(spec('rampAngle', { fitMax: 52 }), 52, 1), 52);
  assert.equal(nudge(spec('rampAngle'), 5, -1), 5);
  assert.equal(nudge(spec('bobMass'), 0.001, -1), 0.001);
});

test('slider covers the whole range and maps back to the same value', () => {
  for (const key of Object.keys(ENTRY_SPECS) as EntryKey[]) {
    const f = spec(key);
    const s = sliderScale(f);
    assert.equal(s.toPos(f.min), 0, key);
    assert.equal(s.toPos(f.max), 1, key);
    const mid = f.quantity === 'angle' ? 40 : f.min < 0 ? -2 : 2;
    assert.ok(Math.abs(s.fromPos(s.toPos(mid)) - mid) < 1e-9, key);
  }
  // Everyday values get room on a wide range: 0.1 kg to 10 kg is a third of a 0.001 to 1000 kg slider.
  const m = sliderScale(spec('bobMass'));
  assert.ok(Math.abs(m.toPos(10) - m.toPos(0.1) - 1 / 3) < 1e-9);
  // A ramp that only fits up to 52° ends there.
  assert.equal(sliderScale(spec('rampAngle', { fitMax: 52 })).fromPos(1), 52);
});

test('slider values are rounded like the buttons', () => {
  assert.equal(niceSliderValue(spec('stringLength'), 0.4337), 0.43);
  assert.equal(niceSliderValue(spec('rampAngle'), 31.6), 32);
  assert.equal(niceSliderValue(spec('leftSpeed'), 0.03), 0);
  assert.equal(showValue(spec('rampAngle'), 31), '31°');
  assert.equal(showValue(spec('bobMass'), 1.234), '1.23 kg');
});

test('a slider shown as a pill (the ramp\'s Friction) steps, slides and reads like its slider', () => {
  const mu = { key: 'friction' as const, label: 'Friction', unit: '', quantity: 'friction' as const, min: 0, max: 1.5, step: 0.05, digits: 2 };
  assert.equal(shortLabel(mu), 'Friction');
  assert.equal(showValue(mu, 0.3), '0.30');
  assert.equal(nudge(mu, 0.3, 1), 0.35);
  assert.equal(nudge(mu, 0.1, -1), 0.05);
  assert.equal(nudge(mu, 0.05, -1), 0);
  assert.equal(nudge(mu, 0, -1), 0);
  assert.equal(nudge(mu, 1.5, 1), 1.5);
  // Linear, like the slider under the controls: 0.75 is half way.
  const s = sliderScale(mu);
  assert.equal(s.toPos(0.75), 0.5);
  assert.equal(s.toPos(0), 0);
  assert.equal(niceSliderValue(mu, s.fromPos(0.2137)), 0.3);
});

test('a seesaw distance steps and slides only as far as the weight fits on the plank', () => {
  const d = spec('leftDistance', { fitMin: 0.04, fitMax: 0.318 });
  assert.equal(nudge(d, 0.3, 1), 0.318);
  assert.equal(nudge(d, 0.318, 1), 0.318);
  assert.equal(nudge(d, 0.05, -1), 0.045);
  assert.equal(nudge(d, 0.045, -1), 0.04);
  assert.equal(sliderScale(d).fromPos(0), 0.04);
  assert.equal(sliderScale(d).fromPos(1), 0.318);
});

test('changing one side of a pulley / seesaw enters the other at the value it shows (it never changes by itself)', () => {
  const shown = (k: EntryKey) => ({ leftMass: 1, rightMass: 1.37, leftDistance: 0.3, rightDistance: 0.2 } as Partial<Record<EntryKey, number>>)[k];
  assert.deepEqual(enterPair({}, 'leftMass', 2, shown), { rightMass: 1.37, leftMass: 2 });
  assert.deepEqual(enterPair({ rightMass: 1.37, leftMass: 2 }, 'leftMass', 5, shown), { rightMass: 1.37, leftMass: 5 });
  assert.deepEqual(enterPair({ rightMass: 1.37, leftMass: 5 }, 'rightMass', 3, shown), { leftMass: 5, rightMass: 3 });
  // The distance left alone goes first: it sets the scale (stays where drawn), the changed weight slides.
  assert.deepEqual(Object.keys(enterPair({ leftMass: 2 }, 'leftDistance', 0.6, shown)), ['rightDistance', 'leftMass', 'leftDistance']);
  const both = enterPair({ rightDistance: 0.2, leftDistance: 0.6 }, 'rightDistance', 0.1, shown);
  assert.deepEqual(both, { leftDistance: 0.6, rightDistance: 0.1 });
  assert.deepEqual(Object.keys(both), ['leftDistance', 'rightDistance']);
  // No other side on screen (one weight): nothing added. Collision balls are read on their own.
  assert.deepEqual(enterPair({}, 'leftMass', 2, () => undefined), { leftMass: 2 });
  assert.deepEqual(enterPair({}, 'leftBallMass', 2, shown), { leftBallMass: 2 });
});

test('the launch\'s Ground is a box under the controls, not a pill under the picture', () => {
  const scene = {
    label: 'Projectile',
    parts: { ball: { kg: 1 } },
    measures: { ground: 500 },
    physics: { launchSpeed: { fit: 3, value: 3 }, launch: { drawnAngleDeg: 40, heightDrawnM: 0 } },
  } as any;
  const fields = fieldsFor(scene, { params: {} } as any);
  assert.deepEqual(fields.map((f) => f.key), ['launchSpeed', 'launchAngle', 'launchHeight', 'projectileMass', 'groundLength']);
  assert.deepEqual(fields.filter((f) => !f.noPill).map(shortLabel), ['Speed', 'Angle', 'Height', 'Mass']);
});
