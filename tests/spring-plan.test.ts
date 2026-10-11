// Spring drawings: the fixed end, axis and block are found from the ink (src/scenes/spring-plan.ts).
// Run: npm test
//
// Cases built at the contour/ink level (no images): a wide zigzag over a small open box, a scribbled zigzag over a
// small box, a coil wider than its box, a short ceiling, a box apart from its spring, horizontal springs. Plus the
// vision output (ink) of samples/generated/spring-gen-01..06, which must keep working.
// The old rule (deepest point of the filled outline + axis from centres) is replayed to show the failure it fixes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { centroidOf, planSpring, splitMerged, type SpringPlan } from '../src/scenes/spring-plan.ts';

type Pt = [number, number];

class Paper {
  W: number;
  H: number;
  pen: number;
  ink: Uint8Array;
  constructor(W = 600, H = 800, pen = 8) {
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
  /** Zigzag between two points along y (vertical) or x, `teeth` teeth of half-width `amp`. */
  zigzag(from: Pt, to: Pt, teeth: number, amp: number) {
    const p: Pt[] = [from];
    const vertical = Math.abs(to[1] - from[1]) > Math.abs(to[0] - from[0]);
    for (let i = 0; i < 2 * teeth; i++) {
      const f = (i + 0.5) / (2 * teeth), s = i % 2 ? -amp : amp;
      const x = from[0] + (to[0] - from[0]) * f, y = from[1] + (to[1] - from[1]) * f;
      p.push(vertical ? [x + s, y] : [x, y + s]);
    }
    p.push(to);
    return this.path(...p);
  }
  circle([cx, cy]: Pt, rx: number, ry = rx) {
    const p: Pt[] = [];
    for (let a = 0; a <= 64; a++) p.push([cx + rx * Math.cos((a / 64) * 2 * Math.PI), cy + ry * Math.sin((a / 64) * 2 * Math.PI)]);
    return this.path(...p);
  }
  box(x: number, y: number, w: number, h: number, openSide = false) {
    this.path([x, y], [x + w, y], [x + w, y + h]);
    this.path([x, y], [x, y + h], [x + w, y + h]);
    if (openSide) for (let yy = y + h * 0.35; yy < y + h * 0.65; yy++) for (let xx = x + w - 8; xx <= x + w + 8; xx++) this.ink[Math.round(yy) * this.W + Math.round(xx)] = 0;
    return this;
  }
  hatch(from: Pt, to: Pt, side: Pt, n = 8) {
    for (let i = 0; i <= n; i++) {
      const x = from[0] + ((to[0] - from[0]) * i) / n, y = from[1] + ((to[1] - from[1]) * i) / n;
      this.line([x, y], [x + side[0], y + side[1]]);
    }
    return this;
  }
}

const centre = (p: SpringPlan) => {
  assert.ok(p.mass, `no block found: ${p.why}`);
  return { x: p.mass!.box.x + p.mass!.box.w / 2, y: p.mass!.box.y + p.mass!.box.h / 2 };
};

/** The block's centre lies inside the drawn box (x0, y0, x1, y1). */
function blockIn(p: SpringPlan, [x0, y0, x1, y1]: number[]) {
  const c = centre(p);
  assert.ok(c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1, `block centre (${c.x.toFixed(0)},${c.y.toFixed(0)}) not in the box ${[x0, y0, x1, y1]}: ${p.why}`);
}

/** What contourMask (filled outer outline, 4 px stroke margin) gives for one stroke group: ink + enclosed paper. */
function filledOutline(ink: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H).fill(1);
  const stack: number[] = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (!out[i] || ink[i]) continue;
    out[i] = 0;
    const x = i % W;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (i >= W) stack.push(i - W);
    if (i < W * (H - 1)) stack.push(i + W);
  }
  const grown = out.slice();
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) continue;
    const x = i % W, y = (i - x) / W;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && dx * dx + dy * dy <= 16) grown[yy * W + xx] = 1;
    }
  }
  return grown;
}

/** The rule before this fix: block = band round the deepest point of the filled outline, axis from the centres. */
function oldRule(ink: Uint8Array, W: number, H: number) {
  const split = splitMerged(W, H, filledOutline(ink, W, H), null)!;
  const cm = centroidOf(split.mass, W)!, cs = centroidOf(split.spring, W)!;
  return { block: cm, vertical: Math.abs(cm.y - cs.y) >= Math.abs(cm.x - cs.x) };
}

/** The block band the builder cuts with the plan. */
function newSplit(ink: Uint8Array, W: number, H: number, plan: SpringPlan) {
  const split = splitMerged(W, H, filledOutline(ink, W, H), plan)!;
  assert.ok(split, 'split failed');
  return centroidOf(split.mass, W)!;
}

// ---- Cases built from strokes ----------------------------------------------------------------------------------

test('wide zigzag over a small open box, ceiling drawn off to the left: ceiling on top, the box is the block', () => {
  const p = new Paper();
  p.line([40, 100], [380, 100]).line([300, 100], [300, 140]).zigzag([300, 140], [300, 520], 7, 110).line([300, 520], [300, 560]);
  p.box(262, 560, 76, 60, true);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.equal(plan.fixed?.kind, 'ceiling', plan.why);
  assert.equal(plan.vertical, true);
  blockIn(plan, [255, 550, 345, 630]);
  // The old rule took the zigzag for the block and laid the spring on its side (the ceiling became a wall).
  const old = oldRule(p.ink, p.W, p.H);
  assert.ok(old.block.y < 520, `old rule block at y=${old.block.y.toFixed(0)}`);
  assert.equal(old.vertical, false);
  // The builder's split with the plan cuts the box.
  assert.ok(newSplit(p.ink, p.W, p.H, plan).y > 550);
});

test('scribbled zigzag (teeth nearly touching) over a small closed box: the box, not the zigzag', () => {
  const p = new Paper();
  p.line([60, 90], [420, 90]).line([300, 90], [300, 130]).zigzag([300, 130], [300, 500], 22, 120).line([300, 500], [300, 560]);
  p.box(265, 560, 70, 50);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.equal(plan.vertical, true, plan.why);
  assert.equal(plan.mass?.kind, 'closed', plan.why);
  blockIn(plan, [260, 555, 340, 615]);
  const old = oldRule(p.ink, p.W, p.H);
  assert.ok(old.block.y < 500, `old rule block at y=${old.block.y.toFixed(0)}`);
  assert.ok(newSplit(p.ink, p.W, p.H, plan).y > 555);
});

test('coil wider than its box: the loops repeat, the box at the end is the block', () => {
  const p = new Paper();
  p.line([80, 80], [520, 80]).line([300, 80], [300, 130]);
  for (let i = 0; i < 6; i++) p.circle([300, 160 + i * 55], 75, 38);
  p.line([300, 473], [300, 540]).box(268, 540, 64, 56);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.equal(plan.vertical, true, plan.why);
  assert.ok(plan.rejected.some((r) => r.includes('coil')), plan.why);
  blockIn(plan, [262, 535, 338, 600]);
  assert.ok(oldRule(p.ink, p.W, p.H).block.y < 520);
});

test('short ceiling (narrower than the block): still a hanging spring', () => {
  const p = new Paper();
  p.line([250, 120], [350, 120]).zigzag([300, 120], [300, 460], 6, 40).box(200, 460, 200, 140);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.equal(plan.fixed?.kind, 'ceiling', plan.why);
  assert.equal(plan.vertical, true);
  blockIn(plan, [200, 460, 400, 600]);
});

test('ceiling with hatching: reported as hatched', () => {
  const p = new Paper();
  p.line([150, 150], [450, 150]).hatch([160, 150], [440, 150], [-20, -26], 10).zigzag([300, 150], [300, 480], 6, 50).box(240, 480, 120, 90);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.equal(plan.fixed?.kind, 'ceiling', plan.why);
  assert.equal(plan.fixed?.hatch, true, plan.why);
  blockIn(plan, [240, 480, 360, 570]);
});

test('box drawn apart from its spring: the box is still the block', () => {
  const p = new Paper();
  p.line([120, 100], [480, 100]).zigzag([300, 100], [300, 420], 6, 70).box(250, 480, 100, 80);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.equal(plan.vertical, true, plan.why);
  blockIn(plan, [250, 480, 350, 560]);
});

test('horizontal: hatched wall on the left, floor, box on the right', () => {
  const p = new Paper(800, 600);
  p.line([100, 150], [100, 450]).hatch([100, 160], [100, 440], [-25, 20], 9).line([60, 450], [760, 450]);
  p.line([100, 330], [150, 330]).zigzag([150, 330], [450, 330], 6, 40).line([450, 330], [500, 330]).box(500, 260, 160, 190);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.equal(plan.fixed?.kind, 'wall', plan.why);
  assert.equal(plan.fixed?.hatch, true);
  assert.equal(plan.vertical, false);
  blockIn(plan, [500, 260, 660, 450]);
});

test('horizontal with a short wall and an open box whose top edge is the top of the drawing: not a ceiling', () => {
  const p = new Paper(800, 600);
  p.line([80, 260], [80, 400]).line([80, 330], [130, 330]).zigzag([130, 330], [400, 330], 5, 35).line([400, 330], [440, 330]);
  p.box(440, 250, 220, 160, true);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.equal(plan.fixed?.kind, 'wall', plan.why);
  assert.equal(plan.vertical, false);
  blockIn(plan, [440, 250, 660, 410]);
});

test('nothing to hang from: still hanging (never sideways), the box is the block', () => {
  // The top tooth may pass for a short ceiling; either way the spring hangs and the box is the block.
  const p = new Paper();
  p.zigzag([300, 100], [300, 400], 6, 40).box(250, 400, 100, 80);
  const plan = planSpring(p.ink, p.W, p.H);
  assert.notEqual(plan.vertical, false, plan.why);
  assert.notEqual(plan.fixed?.kind, 'wall');
  blockIn(plan, [250, 400, 350, 480]);
});

// ---- Vision output of the sample photos ------------------------------------------------------------------------

const FIX = new URL('./fixtures/', import.meta.url);
const expected: Record<string, { kind: 'ceiling' | 'wall'; box: number[] }> = {
  // Drawn box, in the 720 / 960 px working image (from the photo).
  'spring-gen-01': { kind: 'ceiling', box: [280, 580, 460, 700] },
  'spring-gen-02': { kind: 'wall', box: [570, 290, 800, 500] },
  'spring-gen-03': { kind: 'ceiling', box: [318, 565, 486, 720] },
  'spring-gen-04': { kind: 'wall', box: [610, 255, 860, 450] },
  'spring-gen-05': { kind: 'ceiling', box: [270, 650, 470, 810] },
  'spring-gen-06': { kind: 'ceiling', box: [320, 665, 445, 780] },
};
for (const f of readdirSync(FIX).filter((f) => f.endsWith('.ink.json')).sort()) {
  const name = f.replace('.ink.json', '');
  test(`sample ${name}: ${expected[name]?.kind} found, block is the drawn box`, () => {
    const d = JSON.parse(readFileSync(new URL(f, FIX), 'utf8'));
    const bits = inflateSync(Buffer.from(d.inkBitsDeflate, 'base64'));
    const ink = new Uint8Array(d.width * d.height);
    for (let i = 0; i < ink.length; i++) if (bits[i >> 3] & (1 << (i & 7))) ink[i] = 255;
    const plan = planSpring(ink, d.width, d.height);
    const e = expected[name];
    assert.equal(plan.fixed?.kind, e.kind, plan.why);
    assert.equal(plan.vertical, e.kind === 'ceiling');
    blockIn(plan, e.box);
  });
}
