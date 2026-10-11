// Safety net when vision finds no lines (src/scenes/blank-patch.ts): what falls must be the faint drawing, never a
// big shadow next to it, and plain paper (or a shadow alone) gives the middle of the photo.
// Run: npm test
//
// Built luma images (no files): paper with a gentle light falloff, a phone shadow pressed into the lower-left corner
// (soft or hard edged, ~45 % darker than the paper), and a faint pencil incline (triangle + box, ~6 % darker than the
// paper and a few px wide - what the first real phone photo looked like). The old rule (darkest window) took the shadow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linePatch, type Patch } from '../src/scenes/blank-patch.ts';

const W = 720, H = 960;
type Pt = [number, number];

function paper(): Float32Array {
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[y * W + x] = 232 - (12 * y) / H - (4 * x) / W;
  return a;
}

/** Rounded rectangle shadow: luma scaled by `depth` inside, blending over `soft` px at its edge. */
function shadow(a: Float32Array, x0: number, y0: number, x1: number, y1: number, radius: number, soft: number, depth = 0.55) {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // Signed distance to the rounded rectangle (negative inside).
      const qx = Math.abs(x - (x0 + x1) / 2) - (x1 - x0) / 2 + radius;
      const qy = Math.abs(y - (y0 + y1) / 2) - (y1 - y0) / 2 + radius;
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const t = Math.min(1, Math.max(0, 0.5 - sd / Math.max(1, soft)));
      a[y * W + x] *= 1 - (1 - depth) * t;
    }
}

/** Faint pencil line: `depth` (share of the local paper) at its centre, fading out over `half` px. */
function pencil(a: Float32Array, p: Pt, q: Pt, depth = 0.065, half = 3) {
  const [x0, y0] = p, [x1, y1] = q, L2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
  for (let y = Math.floor(Math.min(y0, y1) - half); y <= Math.ceil(Math.max(y0, y1) + half); y++)
    for (let x = Math.floor(Math.min(x0, x1) - half); x <= Math.ceil(Math.max(x0, x1) + half); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / L2));
      const d = Math.hypot(x - x0 - t * (x1 - x0), y - y0 - t * (y1 - y0));
      if (d < half) a[y * W + x] *= 1 - depth * (1 - d / half);
    }
}

/** The drawing: an incline (right angle bottom-left) with a box on its slope, in the upper middle of the photo. */
const DRAWING = { x0: 180, y0: 200, x1: 620, y1: 560 };
function incline(a: Float32Array) {
  pencil(a, [180, 250], [180, 560]);
  pencil(a, [180, 560], [620, 560]);
  pencil(a, [180, 250], [620, 560]);
  pencil(a, [300, 335], [350, 265]);
  pencil(a, [350, 265], [420, 315]);
  pencil(a, [420, 315], [370, 385]);
}

const toLuma = (a: Float32Array) => Uint8Array.from(a, (v) => Math.round(v));
const overlap = (p: Patch, x0: number, y0: number, x1: number, y1: number) =>
  Math.max(0, Math.min(p.x + p.w, x1) - Math.max(p.x, x0)) * Math.max(0, Math.min(p.y + p.h, y1) - Math.max(p.y, y0));
const isMiddle = (p: Patch) => Math.abs(p.x + p.w / 2 - W / 2) < 2 && Math.abs(p.y + p.h / 2 - H / 2) < 2;

for (const [name, soft] of [['soft', 40], ['hard', 3]] as const) {
  test(`faint pencil incline next to a ${name}-edged phone shadow: the incline falls, not the shadow`, () => {
    const a = paper();
    shadow(a, -60, 640, 330, 1100, 50, soft);
    incline(a);
    const p = linePatch(toLuma(a), W, H);
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    assert.ok(cx > DRAWING.x0 && cx < DRAWING.x1 && cy > DRAWING.y0 && cy < DRAWING.y1, `patch ${JSON.stringify(p)} is not on the drawing`);
    assert.ok(overlap(p, 0, 640, 330, H) < 0.05 * p.w * p.h, `patch ${JSON.stringify(p)} covers the shadow`);
    // It is (mostly) a piece of the drawing.
    assert.ok(overlap(p, DRAWING.x0, DRAWING.y0, DRAWING.x1, DRAWING.y1) > 0.7 * p.w * p.h, `patch ${JSON.stringify(p)} is mostly off the drawing`);
  });

  test(`a ${name}-edged shadow alone gives the middle of the photo`, () => {
    const a = paper();
    shadow(a, -60, 640, 330, 1100, 50, soft);
    assert.ok(isMiddle(linePatch(toLuma(a), W, H)));
  });
}

test('plain paper gives the middle of the photo', () => {
  assert.ok(isMiddle(linePatch(toLuma(paper()), W, H)));
});
