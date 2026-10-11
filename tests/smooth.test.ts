// Drawing between physics steps (src/smooth.ts): every frame moves the picture a little at slow speeds, the physics
// is put back exactly, and a relaunch is drawn where it lands (no slide from the old place).
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { PoseLerp } from '../src/smooth';
import { StepClock } from '../src/playback';

function box() {
  const b = Matter.Bodies.rectangle(100, 100, 20, 20);
  Matter.Body.setVelocity(b, { x: 3, y: 0 });
  return b;
}

/** One frame: the clock's steps (each moves the body by `move`), then the drawn x. */
function frame(lerp: PoseLerp, clock: StepClock, b: Matter.Body, rate: number, move: (b: Matter.Body) => void) {
  const steps = clock.next(rate);
  for (let i = 0; i < steps; i++) {
    if (i === steps - 1) lerp.beforeStep([b], []);
    move(b);
  }
  if (steps > 0) lerp.afterStep([b], []);
  const before = { x: b.position.x, v: b.vertices[0].x, vx: b.velocity.x, prev: (b as unknown as { positionPrev: Matter.Vector }).positionPrev.x };
  lerp.apply([b], [], clock.frac);
  const drawn = b.position.x;
  const drawnVertex = b.vertices[0].x;
  lerp.restore();
  assert.equal(b.position.x, before.x, 'position put back exactly');
  assert.equal(b.vertices[0].x, before.v, 'vertices put back exactly');
  assert.equal(b.velocity.x, before.vx, 'velocity untouched');
  assert.equal((b as unknown as { positionPrev: Matter.Vector }).positionPrev.x, before.prev, 'positionPrev put back');
  assert.ok(Math.abs(drawnVertex - drawn - (before.v - before.x)) < 1e-9, 'vertices drawn with the body');
  return drawn;
}

test('at 1/36 step per frame the drawn body moves every frame, never backwards', () => {
  const lerp = new PoseLerp();
  const clock = new StepClock();
  const b = box();
  let last = -Infinity;
  let still = 0;
  for (let f = 0; f < 200; f++) {
    const x = frame(lerp, clock, b, 1 / 36, (body) => Matter.Body.setPosition(body, { x: body.position.x + 10, y: 100 }));
    if (f > 0 && x === last) still++;
    assert.ok(x >= last - 1e-9, 'never steps back');
    last = x;
  }
  assert.ok(still <= 2, `frames drawn at the same place: ${still}`);
});

test('a relaunch (big jump after being still) is drawn at once, not slid', () => {
  const lerp = new PoseLerp();
  const clock = new StepClock();
  const b = box();
  // Resting for a while (steps that do not move it).
  for (let f = 0; f < 40; f++) frame(lerp, clock, b, 0.25, () => {});
  // Next step teleports it 300 px back: every frame after it draws it at the new place.
  let jumped = false;
  for (let f = 0; f < 8; f++) {
    const x = frame(lerp, clock, b, 0.25, (body) => {
      if (!jumped) Matter.Body.setPosition(body, { x: body.position.x - 300, y: 100 });
      jumped = true;
    });
    if (jumped) assert.equal(x, b.position.x);
  }
});

test('a body moved outside a step (an entered value) is drawn where it is', () => {
  const lerp = new PoseLerp();
  const clock = new StepClock();
  const b = box();
  for (let f = 0; f < 5; f++) frame(lerp, clock, b, 0.25, (body) => Matter.Body.setPosition(body, { x: body.position.x + 10, y: 100 }));
  Matter.Body.setPosition(b, { x: 500, y: 100 });
  lerp.apply([b], [], 0.5);
  assert.equal(b.position.x, 500);
  lerp.restore();
});
