// The number pills under the picture (src/quick.ts): names, − / + steps and the slider scale, for every box
// fieldsFor() can make. Placeholders carry the value only (no "assumed" / "drawn"). Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_SPECS, type EntryKey } from '../src/entries.ts';
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
