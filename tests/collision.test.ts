// Ball collision: the 1-D motion (src/scenes/collision-physics.ts) and the offline guess (src/guess.ts).
// Run: npm test
//
// Physics: momentum is the same before and after every ball-ball hit (within 0.1 %), e = 1 keeps the kinetic energy,
// e = 0 makes the two move together, walls bounce, and a pair pinned against a wall comes to rest (no endless bounces).
// Guess: drawings built at the ink/contour level (no images): two balls on a level floor with level arrows are a
// collision; one ball with a slanted arrow stays a projectile; two balls without a floor or arrows are not a collision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, atRest, collide, kinetic, momentum, type Ball1D, type Walls } from '../src/scenes/collision-physics.ts';
import { guessDiagram } from '../src/guess.ts';
import type { Contour } from '../src/types.ts';

const pair = (m1: number, v1: number, m2: number, v2: number, x1 = 300, x2 = 700, r = 40): [Ball1D, Ball1D] => [
  { x: x1, v: v1, r, m: m1 },
  { x: x2, v: v2, r, m: m2 },
];
const WIDE: Walls = { x0: -1e6, x1: 1e6 };
const close = (a: number, b: number, rel = 1e-3, what = '') =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1e-9, Math.abs(a), Math.abs(b)), `${what} ${a} vs ${b}`);

/** Run until the first ball-ball hit is over, then report momentum / energy before and after. */
function throughHit(balls: [Ball1D, Ball1D], e: number, walls = WIDE) {
  const p0 = momentum(balls), k0 = kinetic(balls);
  let hits = 0;
  for (let s = 0; s < 5000 && !hits; s++) hits += advance(balls, 1, walls, e).hits;
  assert.ok(hits > 0, 'the balls met');
  return { p0, p1: momentum(balls), k0, k1: kinetic(balls) };
}

test('momentum is conserved through a hit, for every e and mass ratio', () => {
  for (const e of [0, 0.3, 0.7, 1])
    for (const [m1, v1, m2, v2] of [[1, 3, 1, 0], [2, 3, 1, -1], [1, 4, 5, 0], [0.4, 2, 3, -2.5], [3, 1, 1, -3]]) {
      const r = throughHit(pair(m1, v1, m2, v2), e);
      close(r.p1, r.p0, 1e-3, `e=${e} m=${m1},${m2} momentum`);
    }
});

test('e = 1: kinetic energy kept; e < 1: it drops by (1 − e²) of the energy of the relative motion', () => {
  const r = throughHit(pair(2, 3, 1, -1), 1);
  close(r.k1, r.k0, 1e-3, 'elastic KE');
  const m1 = 2, m2 = 1, rel = 4, e = 0.5;
  const s = throughHit(pair(m1, 3, m2, -1), e);
  close(s.k0 - s.k1, 0.5 * ((m1 * m2) / (m1 + m2)) * rel * rel * (1 - e * e), 1e-3, 'KE lost');
});

test('equal masses, elastic: the moving ball stops and the other takes its speed (Newton’s cradle)', () => {
  const b = pair(1, 3, 1, 0);
  throughHit(b, 1);
  close(b[0].v + 1, 1, 1e-9, 'left stops');
  close(b[1].v, 3, 1e-9, 'right takes it');
});

test('e = 0: the balls move on together at the centre-of-mass speed', () => {
  const b = pair(3, 2, 1, -2);
  throughHit(b, 0);
  close(b[0].v, b[1].v, 1e-9, 'same speed');
  close(b[0].v, (3 * 2 + 1 * -2) / 4, 1e-9, 'centre of mass speed');
  for (let s = 0; s < 50; s++) advance(b, 1, WIDE, 0);
  close(b[1].x - b[0].x, b[0].r + b[1].r, 1e-9, 'stay touching');
});

test('collide() matches the textbook formula', () => {
  const [a, b] = collide(2, 5, 3, -1, 0.6);
  close(a, (2 * 5 + 3 * -1 - 3 * 0.6 * 6) / 5, 1e-12);
  close(b, (2 * 5 + 3 * -1 + 2 * 0.6 * 6) / 5, 1e-12);
});

test('a hit inside one step is found exactly, even very fast (no tunnelling)', () => {
  const b = pair(1, 900, 1, 0, 100, 400, 10);
  const rep = advance(b, 1, { x0: 0, x1: 100000 }, 1);
  assert.equal(rep.hits, 1);
  close(b[0].v + 1, 1, 1e-9);
  close(b[1].v, 900, 1e-9);
  assert.ok(b[1].x - b[0].x >= b[0].r + b[1].r - 1e-9, 'not overlapping');
});

test('walls bounce with e, and the balls never leave the floor or overlap', () => {
  const walls: Walls = { x0: 0, x1: 1000 };
  const b = pair(1, 7, 2.5, -4, 200, 800, 50);
  for (let s = 0; s < 3000; s++) {
    advance(b, 1, walls, 1);
    assert.ok(b[0].x - b[0].r >= -1e-9 && b[1].x + b[1].r <= 1000 + 1e-9, 'inside the walls');
    assert.ok(b[1].x - b[0].x >= 100 - 1e-9, 'not overlapping');
  }
  // Elastic everywhere: the energy is the same after thousands of hits.
  close(kinetic(b), 0.5 * 7 * 7 + 0.5 * 2.5 * 16, 1e-6, 'elastic with walls');
});

test('e < 1 with walls: everything comes to rest (under 5 % of the start speed) within seconds, without endless bounces', () => {
  for (const e of [0, 0.4, 0.8]) {
    const b = pair(1, 6, 1.5, -3, 300, 600, 40);
    let s = 0;
    for (; s < 20000 && !atRest(b, 6); s++) advance(b, 1, { x0: 0, x1: 900 }, e);
    // Inelastic enough: within 30 s at 60 steps per second. Nearly elastic (0.8) takes longer, but stops too.
    assert.ok(atRest(b, 6) && (e > 0.5 || s < 60 * 30), `e=${e} at rest after ${s} steps`);
  }
  // Pinned against the wall by a heavier ball: a few bounces per step at most, never the 64-event cap, never overlapping.
  for (const e of [0.5, 0.8, 1]) {
    const b = pair(1, -2, 5, -2, 60, 200, 40);
    for (let s = 0; s < 2000; s++) {
      const r = advance(b, 1, { x0: 0, x1: 900 }, e);
      assert.ok(r.hits + r.walls < 16, `e=${e} step ${s}: ${r.hits} hits, ${r.walls} wall hits`);
      assert.ok(b[0].x - 40 >= -1e-9 && b[1].x - b[0].x >= 80 - 1e-9, 'valid positions');
    }
  }
});

// ---- Offline guess ------------------------------------------------------------------------------------------

type Pt = [number, number];

class Paper {
  W: number;
  H: number;
  pen: number;
  ink: Uint8Array;
  contours: Contour[] = [];
  constructor(W = 900, H = 650, pen = 7) {
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
  path(closed: boolean, ...p: Pt[]) {
    for (let i = 1; i < p.length; i++) this.line(p[i - 1], p[i]);
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    this.contours.push({
      id: this.contours.length,
      points: p.map(([px, py]) => ({ x: px, y: py })),
      hull: [],
      bbox: { x, y, w, h },
      centroid: { x: x + w / 2, y: y + h / 2 },
      area: closed ? w * h : 0,
      inkPixels: Math.round(p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0) * this.pen),
      hasHole: closed,
    });
    return this;
  }
  circle([cx, cy]: Pt, r: number) {
    const p: Pt[] = [];
    for (let a = 0; a <= 64; a++) p.push([cx + r * Math.cos((a / 64) * 2 * Math.PI), cy + r * Math.sin((a / 64) * 2 * Math.PI)]);
    return this.path(true, ...p);
  }
  /** Arrow from tail to head with two barbs. */
  arrow(tail: Pt, head: Pt) {
    const L = Math.hypot(head[0] - tail[0], head[1] - tail[1]);
    const u = [(head[0] - tail[0]) / L, (head[1] - tail[1]) / L];
    const b = 0.25 * L;
    const barb = (s: number): Pt => [head[0] - u[0] * b - s * u[1] * b * 0.6, head[1] - u[1] * b + s * u[0] * b * 0.6];
    return this.path(false, barb(1), head, barb(-1)).path(false, tail, head);
  }
  guess() {
    return guessDiagram({ width: this.W, height: this.H, ink: this.ink, contours: this.contours });
  }
}

test('guess: two balls on a level floor with level arrows towards each other = collision', () => {
  const p = new Paper();
  p.path(false, [60, 470], [840, 474]); // floor
  p.circle([250, 420], 45).circle([640, 427], 45);
  p.arrow([310, 420], [420, 418]).arrow([580, 427], [480, 425]);
  const g = p.guess();
  assert.equal(g.diagram, 'collision', g.why);
});

test('guess: one arrow only, balls of different sizes, floor tilted 6° = collision', () => {
  const p = new Paper();
  const y = (x: number) => 480 + Math.tan((6 * Math.PI) / 180) * (x - 450);
  p.path(false, [60, y(60)], [840, y(840)]);
  p.circle([230, y(230) - 34], 30).circle([620, y(620) - 58], 54);
  p.arrow([175, y(230) - 105], [300, y(300) - 105]); // drawn above the ball, a textbook habit
  const g = p.guess();
  assert.equal(g.diagram, 'collision', g.why);
});

test('guess: a ball with a slanted launch arrow on the ground stays a projectile', () => {
  const p = new Paper();
  p.path(false, [60, 520], [840, 520]);
  p.circle([200, 472], 42);
  p.arrow([235, 440], [330, 345]);
  assert.equal(p.guess().diagram, 'projectile');
});

test('guess: two balls on a floor whose only arrows point up are not a collision', () => {
  const p = new Paper();
  p.path(false, [60, 520], [840, 520]);
  p.circle([250, 472], 42).circle([600, 472], 42);
  p.arrow([250, 410], [250, 300]);
  assert.notEqual(p.guess().diagram, 'collision');
});

test('guess: two balls with level arrows but no floor under them are not a collision', () => {
  const p = new Paper();
  p.circle([250, 300], 42).circle([600, 300], 42);
  p.arrow([310, 300], [420, 300]);
  assert.notEqual(p.guess().diagram, 'collision');
});
