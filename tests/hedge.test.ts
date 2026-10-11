// Hedged Gemini requests (src/hedge.ts): a slow model must not hold up the answer, and no model is asked needlessly.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSuccess } from '../src/hedge.ts';

type Plan = { ms: number; ok: boolean } | 'hang';

/** Attempts that answer (or fail) after `ms`, or never; records which ones started and which were aborted. */
function fake(plans: Plan[]) {
  const started: number[] = [];
  const aborted: number[] = [];
  const attempt = (i: number, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      started.push(i);
      let settled = false;
      signal.addEventListener('abort', () => {
        if (settled) return; // aborting a finished request does nothing
        aborted.push(i);
        reject(new Error('aborted'));
      });
      const p = plans[i];
      if (p === 'hang') return;
      setTimeout(() => {
        settled = true;
        if (p.ok) resolve(`m${i}`);
        else reject(new Error(`m${i} failed`));
      }, p.ms);
    });
  return { attempt, started, aborted };
}

const opts = { hedgeMs: 40, totalMs: 400, maxInFlight: 3 };

test('a quick first answer asks only one model', async () => {
  const f = fake([{ ms: 5, ok: true }, { ms: 5, ok: true }]);
  assert.equal(await firstSuccess(2, f.attempt, opts), 'm0');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(f.started, [0]);
});

test('a hung first model: the next one starts after hedgeMs and its answer wins', async () => {
  const f = fake(['hang', { ms: 5, ok: true }, { ms: 5, ok: true }]);
  const t0 = Date.now();
  assert.equal(await firstSuccess(3, f.attempt, opts), 'm1');
  assert.ok(Date.now() - t0 < 150, 'answered well before the budget');
  assert.deepEqual(f.started, [0, 1]);
  assert.deepEqual(f.aborted, [0], 'the hung request is cancelled');
});

test('a failure starts the next model at once, without waiting hedgeMs', async () => {
  const f = fake([{ ms: 1, ok: false }, { ms: 1, ok: true }]);
  const t0 = Date.now();
  assert.equal(await firstSuccess(2, f.attempt, opts), 'm1');
  assert.ok(Date.now() - t0 < 30);
});

test('the slow first answer still counts if it beats the hedged one', async () => {
  const f = fake([{ ms: 60, ok: true }, { ms: 200, ok: true }]);
  assert.equal(await firstSuccess(2, f.attempt, opts), 'm0');
  assert.deepEqual(f.aborted, [1]);
});

test('every model failing gives null right away', async () => {
  const f = fake([{ ms: 1, ok: false }, { ms: 1, ok: false }, { ms: 1, ok: false }]);
  const t0 = Date.now();
  assert.equal(await firstSuccess(3, f.attempt, opts), null);
  assert.ok(Date.now() - t0 < 50);
});

test('all hung: null at totalMs, never more than maxInFlight at once, all aborted', async () => {
  const f = fake(['hang', 'hang', 'hang', 'hang', 'hang']);
  const t0 = Date.now();
  assert.equal(await firstSuccess(5, f.attempt, { hedgeMs: 20, totalMs: 150, maxInFlight: 3 }), null);
  assert.ok(Date.now() - t0 >= 140);
  assert.deepEqual(f.started, [0, 1, 2]);
  assert.deepEqual(f.aborted.sort(), [0, 1, 2]);
});

test('no models: null', async () => {
  assert.equal(await firstSuccess(0, fake([]).attempt, opts), null);
});
