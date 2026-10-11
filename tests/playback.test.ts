// Playback speed (src/playback.ts): the badge's cycle, steps per frame, the cap and the label.
// Run: npm test
//
// The physics is the same at every speed (a step is always STEP_S × timeFactor physical seconds); only the number of
// steps a frame runs changes. So "0.11× plays 1/9 of real time" means: over the same frames, 1/9 of the steps of 1×.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleSpeed, MAX_STEPS_PER_FRAME, playbackSpeed, playedSpeed, ScreenWait, SPEEDS, speedLabel, StepClock, stepRate, stepsForScreen } from '../src/playback.ts';
import { DEFAULT_SCALE, STEP_S } from '../src/units.ts';

const TF = DEFAULT_SCALE.timeFactor; // a 960 px paper of 1 m, 0.326

/** Steps run over `frames` frames at this speed, and the most any one frame ran. */
function run(speed: number, tf: number, frames: number) {
  const clock = new StepClock();
  let total = 0, most = 0;
  for (let i = 0; i < frames; i++) {
    const n = clock.next(stepRate(speed, tf));
    total += n;
    most = Math.max(most, n);
  }
  return { total, most };
}

test('starts at 1× and the badge cycles 1 -> 0.5 -> 0.33 -> 0.11 -> 1', () => {
  assert.equal(playbackSpeed(), 1);
  const seen = [cycleSpeed(), cycleSpeed(), cycleSpeed(), cycleSpeed()];
  assert.deepEqual(seen, [1 / 2, 1 / 3, 1 / 9, 1]);
  assert.equal(playbackSpeed(), 1);
});

test('each speed plays that share of physical time per screen second (1 m paper)', () => {
  assert.ok(Math.abs(TF - 0.33) < 0.01, `timeFactor ${TF}`);
  const frames = 60 * 9; // 9 screen seconds
  for (const speed of SPEEDS) {
    const { total } = run(speed, TF, frames);
    const physical = total * STEP_S * TF;
    assert.ok(Math.abs(physical / 9 - speed) < 0.03 * speed, `speed ${speed}: ${physical / 9} physical s per screen s`);
  }
  // Steps come in an even rhythm: 3 a frame at 1×, 1 a frame at 0.33× (as before this setting existed),
  // 1 then 2 at 0.5×, 1 every third frame at 0.11×.
  assert.equal(stepRate(1, TF), 3);
  assert.equal(stepRate(1 / 2, TF), 1.5);
  assert.equal(stepRate(1 / 3, TF), 1);
  assert.equal(stepRate(1 / 9, TF), 1 / 3);
  // 0.11× is 1/9 of 1×.
  assert.equal(run(1, TF, 900).total / run(1 / 9, TF, 900).total, 9);
});

test('a slow rate still steps on the first frame', () => {
  assert.equal(new StepClock().next(stepRate(1 / 9, TF)), 1);
});

test('steps per frame are capped, and the label then shows the speed actually played', () => {
  const tf = 0.01; // a drawing that stands for a huge machine: 1× would need 100 steps a frame
  assert.equal(stepRate(1, tf), MAX_STEPS_PER_FRAME);
  assert.ok(run(1, tf, 100).most <= MAX_STEPS_PER_FRAME);
  assert.ok(Math.abs(playedSpeed(1, tf) - MAX_STEPS_PER_FRAME * tf) < 1e-9);
  assert.deepEqual(speedLabel(1, tf), { word: 'Slow motion', num: '0.15×' });
});

test('labels', () => {
  assert.deepEqual(speedLabel(1, TF), { word: 'Real time', num: '1×' });
  assert.deepEqual(speedLabel(1 / 2, TF), { word: 'Slow motion', num: '0.5×' });
  assert.deepEqual(speedLabel(1 / 3, TF), { word: 'Slow motion', num: '0.33×' });
  assert.deepEqual(speedLabel(1 / 9, TF), { word: 'Slow motion', num: '0.11×' });
  // A tiny drawing (timeFactor > 1) plays fewer than one step a frame at every speed, so all speeds are exact.
  assert.deepEqual(speedLabel(1, 1.6), { word: 'Real time', num: '1×' });
});

// ---- Waits on screen --------------------------------------------------------------------------------------------
// A rest before a replay used to be counted in steps: at 1× (3 to 15 steps a frame) the seesaw rested 0.2 s, at
// 0.11× the ramp 8 s. Counted in screen seconds it lasts the same at every speed.

function setSpeed(speed: number) {
  while (playbackSpeed() !== speed) cycleSpeed();
}

/** Frames (as sim.ts runs them) until the wait is over, at the current speed. */
function framesUntil(wait: ScreenWait, tf: number, onStep: () => boolean = () => wait.tick()): number {
  const clock = new StepClock();
  for (let frame = 1; frame < 100_000; frame++) {
    const n = clock.next(stepRate(playbackSpeed(), tf));
    for (let i = 0; i < n; i++) if (onStep()) return frame;
  }
  return Infinity;
}

test('a ScreenWait lasts its seconds on screen at every speed, also when the step cap holds 1× back', () => {
  for (const tf of [TF, 0.01, 1.6]) {
    for (const speed of SPEEDS) {
      setSpeed(speed);
      const frames = framesUntil(new ScreenWait(1, () => tf), tf);
      // Whole frames: at 0.11× a step comes every 3rd frame (and covers the next two), so it can be 2 frames off.
      assert.ok(frames >= 57 && frames <= 63, `tf ${tf}, ${speed}×: ${frames} frames for 1 s`);
    }
  }
  setSpeed(1);
  assert.equal(stepsForScreen(1, TF), 180);
  assert.equal(stepsForScreen(1, TF, 1 / 9), 20);
});

test('a speed change in the middle of a wait only changes what is left of it', () => {
  setSpeed(1);
  const wait = new ScreenWait(1, () => TF);
  const clock = new StepClock();
  let frames = 0;
  for (; frames < 30; frames++) for (let i = clock.next(stepRate(playbackSpeed(), TF)); i > 0; i--) assert.equal(wait.tick(), false);
  setSpeed(1 / 9);
  const rest = framesUntil(wait, TF);
  setSpeed(1);
  assert.ok(frames + rest >= 57 && frames + rest <= 63, `${frames} + ${rest} frames`);
});
