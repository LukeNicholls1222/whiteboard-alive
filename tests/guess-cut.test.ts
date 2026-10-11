// Offline guess (src/guess.ts) on drawings that judges make at the venue: cut off by the photo edge, drawn small in a
// corner, or with a ring cut open by the id box of a neighbouring contour (the guess reads its ink back from the
// annotated photo, where those boxes are masked out). Built at the ink level, no images.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessDiagram } from '../src/guess.ts';

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
  circle([cx, cy]: Pt, r: number, from = 0, to = 2 * Math.PI) {
    const p: Pt[] = [];
    for (let k = 0; k <= 64; k++) {
      const a = from + ((to - from) * k) / 64;
      p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return this.path(...p);
  }
  box(x0: number, y0: number, x1: number, y1: number) {
    return this.path([x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]);
  }
  arrow(tail: Pt, head: Pt) {
    const L = Math.hypot(head[0] - tail[0], head[1] - tail[1]);
    const u = [(head[0] - tail[0]) / L, (head[1] - tail[1]) / L];
    const b = 0.25 * L;
    const barb = (s: number): Pt => [head[0] - u[0] * b - s * u[1] * b * 0.6, head[1] - u[1] * b + s * u[0] * b * 0.6];
    return this.path(barb(1), head, barb(-1)).path(tail, head);
  }
  /** Erase a 4 px band (an id box edge on the annotated photo). */
  erase(x0: number, y0: number, x1: number, y1: number) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.ink[y * this.W + x] = 0;
    return this;
  }
  guess() {
    return guessDiagram({ width: this.W, height: this.H, ink: this.ink, contours: [] });
  }
}

test('guess: a ball whose ring is cut by a neighbour id box edge still counts (collision)', () => {
  const p = new Paper();
  p.path([60, 440], [900, 432]); // floor
  p.circle([260, 380], 52).circle([700, 376], 52);
  p.arrow([200, 290], [340, 286]).arrow([760, 292], [620, 290]);
  // Box edges of the arrows' id boxes run straight through both rings.
  p.erase(560, 326, 790, 330).erase(170, 330, 360, 334);
  const g = p.guess();
  assert.equal(g.diagram, 'collision', g.why);
});

test('guess: a ramp whose far corner runs off the photo is still an incline', () => {
  const p = new Paper();
  p.path([250, 560], [1000, 160]); // slope, off the right edge
  p.path([250, 560], [959, 560]); // base, to the edge
  p.box(520, 330, 620, 400); // block on the slope (roughly)
  const g = p.guess();
  assert.equal(g.diagram, 'incline', g.why);
});

test('guess: a small ramp in a corner with a ball resting on its slope is an incline, not a projectile', () => {
  const p = new Paper(960, 720, 7);
  const A: Pt = [560, 550], B: Pt = [830, 430], C: Pt = [830, 550];
  p.path(A, B, C, A);
  // Ball touching the slope: centre one radius (+ pen) off the slope, along its normal.
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const nx = (B[1] - A[1]) / L, ny = -(B[0] - A[0]) / L; // normal pointing up-left of the slope
  const r = 27, at: Pt = [A[0] + (B[0] - A[0]) * 0.4, A[1] + (B[1] - A[1]) * 0.4];
  p.circle([at[0] + nx * (r + 7), at[1] + ny * (r + 7)], r);
  const g = p.guess();
  assert.equal(g.diagram, 'incline', g.why);
});

test('guess: two weights hanging from a wheel cut off by the top of the photo = pulley', () => {
  const p = new Paper(960, 720, 15);
  p.circle([525, 10], 135, 0, Math.PI); // lower half of the wheel; the rest is past the top edge
  p.path([390, 10], [390, 400]).path([660, 10], [690, 380]); // ropes
  p.box(270, 400, 510, 600).box(640, 380, 780, 500); // weights
  const g = p.guess();
  assert.equal(g.diagram, 'pulley', g.why);
});
