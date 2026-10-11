// Spring drawings without trusted roles: find the fixed end, the axis and the block from the ink alone, before any
// splitting. Pure (no DOM, no Matter), so it runs in node tests (tests/spring-plan.test.ts).
//
// Order (most reliable first):
//   1. Fixed end = a long straight line (Hough-like search, ±18° of level / plumb, at least 30% of the drawing's
//      width / height) with ink hanging off its inner part (10-90% of its length; a box's own edge has its sides at
//      its ends instead). Near the top = ceiling, near the left / right = wall, near the bottom = floor. Short strokes
//      in a row on its outer side = hatching (reported, a strong sign it is a support).
//   2. Axis: a ceiling means a hanging (vertical) spring. Horizontal only with a wall and no ceiling.
//   3. Block = a closed shape (an enclosed paper region that fills its box: a drawn box or circle) at the far end from
//      the fixed line. Enclosed regions that repeat along the drawing (coil loops) or are triangles (touching zigzag
//      teeth) are never the block, however big. With no such shape: the far-end band whose sides stay put (a box
//      drawn open, or coloured in); a zigzag's sides move every few pixels, so it never forms that band.
// The old way (deepest point of the filled outline) let a dense zigzag or a coil, which fills solid, outweigh a small
// or open box: the spring became the block, and the axis taken from what was left (ceiling + box) came out sideways.

import type { BBox, Point } from '../types';
import { deepestPoint, maskBounds } from './common';

export interface PlanLine {
  kind: 'ceiling' | 'floor' | 'wall' | 'other';
  horizontal: boolean;
  a: Point;
  b: Point;
  len: number;
  /** Angle from horizontal, degrees. */
  deg: number;
  hatch: boolean;
}

export interface PlanMass {
  /** Bounding box of the block: for a closed shape its inner paper region, for 'end' the band of ink. */
  box: BBox;
  kind: 'closed' | 'end';
  /** Closed shape: area / its box (box ~0.9, circle ~0.78). */
  fill: number;
  /** Zigzag-ness of the block's rows: mean sideways move of its sides per row, in pen widths (box ~0.1). */
  zig: number;
}

export interface SpringPlan {
  stroke: number;
  drawing: BBox | null;
  lines: PlanLine[];
  /** The spring's fixed end (ceiling or wall), null when none was found. */
  fixed: PlanLine | null;
  /** True = hanging spring, false = horizontal, null = no fixed end found (decide another way). */
  vertical: boolean | null;
  mass: PlanMass | null;
  /** Shapes that were not taken as the block, and why (for ?debug). */
  rejected: string[];
  /** One line for ?debug. */
  why: string;
}

interface Hole {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  fill: number;
}

const r1 = (v: number) => Math.round(v);

export function planSpring(ink: Uint8Array, W: number, H: number): SpringPlan {
  const D = maskBounds(ink, W, H);
  const stroke = strokeWidth(ink, W, H);
  const empty: SpringPlan = { stroke, drawing: D, lines: [], fixed: null, vertical: null, mass: null, rejected: [], why: 'no ink' };
  if (!D) return empty;
  const rejected: string[] = [];

  // Closed shapes (enclosed paper). Coil loops repeat; touching zigzag teeth leave triangles.
  const minHole = Math.max(3 * stroke, 0.04 * Math.min(D.w, D.h));
  const holes = enclosed(ink, W, H).filter((h) => h.x1 - h.x0 + 1 >= minHole && h.y1 - h.y0 + 1 >= minHole && h.area <= 0.6 * D.w * D.h);
  // Coil loops: three or more enclosed regions of about the same size and shape, each near the next.
  const aspect = (p: Hole) => (p.x1 - p.x0 + 1) / (p.y1 - p.y0 + 1);
  const similar = (p: Hole, q: Hole) => {
    const sp = Math.max(p.x1 - p.x0, p.y1 - p.y0), sq = Math.max(q.x1 - q.x0, q.y1 - q.y0);
    const d = Math.hypot((p.x0 + p.x1 - q.x0 - q.x1) / 2, (p.y0 + p.y1 - q.y0 - q.y1) / 2);
    const ar = aspect(p) / aspect(q);
    return p.area <= 1.8 * q.area && q.area <= 1.8 * p.area && ar < 1.6 && ar > 1 / 1.6 && d < 2.5 * Math.max(sp, sq);
  };
  const boxes: Hole[] = [];
  for (const h of holes) {
    const size = `${h.x1 - h.x0 + 1}×${h.y1 - h.y0 + 1}`;
    const reps = holes.filter((o) => o !== h && o.fill >= 0.45 && similar(h, o)).length;
    if (reps >= 2) rejected.push(`repeating loop ${size} (×${reps + 1}, coil)`);
    else if (h.fill < 0.6) rejected.push(`${h.fill < 0.56 ? 'triangle' : 'odd shape'} ${size} fill=${h.fill.toFixed(2)}`);
    else boxes.push(h);
  }

  // Long straight lines, minus the edges of closed boxes.
  const near = (p: Point, h: Hole, m: number) => p.x >= h.x0 - m && p.x <= h.x1 + m && p.y >= h.y0 - m && p.y <= h.y1 + m;
  const lines = findLines(ink, W, H, D, stroke).filter((l) => !boxes.some((h) => near(l.a, h, 2 * stroke + 6) && near(l.b, h, 2 * stroke + 6)));
  const centre = { x: D.x + D.w / 2, y: D.y + D.h / 2 };
  let total = 0;
  for (let i = 0; i < ink.length; i++) if (ink[i]) total++;
  for (const l of lines) classify(l, ink, W, H, D, centre, stroke, total);
  const pick = (kind: PlanLine['kind']) =>
    lines.filter((l) => l.kind === kind).sort((p, q) => Number(q.hatch) - Number(p.hatch) || q.len - p.len)[0] ?? null;
  const ceiling = pick('ceiling');
  const wall = pick('wall');
  const fixed = ceiling ?? wall;
  const vertical = ceiling ? true : wall ? false : null;

  let mass: PlanMass | null = null;
  if (fixed) {
    // Which way from the fixed line the spring goes, and the ink on that side (the fixed line and, for a spring
    // lying on a floor, the floor taken out).
    const dirSign = sideSign(fixed, centre);
    const nrm = normal(fixed);
    const side = { x: nrm.x * dirSign, y: nrm.y * dirSign };
    const rest = ink.slice();
    const gone = [fixed, ...(vertical ? [] : lines.filter((l) => l.kind === 'floor'))];
    for (const l of gone) eraseLine(rest, W, H, l, 1.5 * stroke + 2);
    for (let i = 0; i < rest.length; i++) {
      if (!rest[i]) continue;
      const x = i % W, y = (i - x) / W;
      if ((x - fixed.a.x) * side.x + (y - fixed.a.y) * side.y < stroke) rest[i] = 0;
    }
    // Axis frame: u along the spring (growing away from the fixed end), v across.
    const plus = vertical ? side.y > 0 : side.x > 0;
    const uOf = (x: number, y: number) => (vertical ? y : x);
    let far = plus ? -Infinity : Infinity;
    for (let i = 0; i < rest.length; i++)
      if (rest[i]) {
        const x = i % W, u = uOf(x, (i - x) / W);
        far = plus ? Math.max(far, u) : Math.min(far, u);
      }
    if (Number.isFinite(far)) {
      const tol = 3 * stroke + 0.06 * (vertical ? D.h : D.w);
      const farEdge = (h: Hole) => (plus ? (vertical ? h.y1 : h.x1) : vertical ? h.y0 : h.x0);
      const ok: Hole[] = [];
      for (const h of boxes) {
        if (Math.abs(far - farEdge(h)) <= tol) ok.push(h);
        else rejected.push(`closed ${h.x1 - h.x0 + 1}×${h.y1 - h.y0 + 1} not at the far end`);
      }
      const best = ok.sort((p, q) => q.area - p.area)[0];
      if (best) mass = { box: { x: best.x0, y: best.y0, w: best.x1 - best.x0 + 1, h: best.y1 - best.y0 + 1 }, kind: 'closed', fill: best.fill, zig: 0 };
      else mass = endBand(rest, W, H, vertical!, plus, stroke, rejected);
    }
  } else {
    const best = [...boxes].sort((p, q) => q.area - p.area)[0];
    if (best) mass = { box: { x: best.x0, y: best.y0, w: best.x1 - best.x0 + 1, h: best.y1 - best.y0 + 1 }, kind: 'closed', fill: best.fill, zig: 0 };
  }

  const lineText = (l: PlanLine) =>
    `${l.kind}: ${l.horizontal ? 'horizontal' : 'vertical'} line ${l.horizontal ? `y=${r1((l.a.y + l.b.y) / 2)}` : `x=${r1((l.a.x + l.b.x) / 2)}`} len=${r1(l.len)} ${l.deg.toFixed(1)}° hatch=${l.hatch ? 'yes' : 'no'}`;
  const axisText = vertical === null ? 'no ceiling or wall → axis from the parts' : vertical ? 'vertical spring' : 'horizontal spring';
  const massText = mass
    ? `mass: ${mass.kind === 'closed' ? `closed ${mass.fill >= 0.84 ? 'box' : 'shape'} fill=${mass.fill.toFixed(2)}` : `far-end band zig=${mass.zig.toFixed(2)}`} ${mass.box.w}×${mass.box.h} at (${mass.box.x},${mass.box.y})`
    : 'mass: none found → old rule';
  const why = `${fixed ? lineText(fixed) : 'no fixed line'} → ${axisText}; ${massText}${rejected.length ? ` (rejected ${rejected.join(', ')})` : ''}`;
  return { stroke, drawing: D, lines, fixed, vertical, mass, rejected, why };
}

// ---- Lines --------------------------------------------------------------------------------------------------

interface RawLine extends PlanLine {
  cov: number;
}

const normal = (l: PlanLine) => {
  const L = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y) || 1;
  return { x: -(l.b.y - l.a.y) / L, y: (l.b.x - l.a.x) / L };
};

/** +1 / -1: which side of the line (along its normal) the drawing's centre is on. */
function sideSign(l: PlanLine, c: Point) {
  const n = normal(l);
  return (c.x - l.a.x) * n.x + (c.y - l.a.y) * n.y >= 0 ? 1 : -1;
}

/**
 * Long straight lines in the ink: for each angle within ±18° of level (and of plumb), ink is binned into bands
 * ~2.5 pen widths thick; a band is a line where its ink runs on (gaps under 2 pen widths) for at least 30% of the
 * drawing's width (height), at least 75% covered. A zigzag or a row of hatch strokes is too gappy.
 */
function findLines(ink: Uint8Array, W: number, H: number, D: BBox, stroke: number): RawLine[] {
  const pts: number[] = [];
  for (let y = D.y; y < D.y + D.h; y++) for (let x = D.x; x < D.x + D.w; x++) if (ink[y * W + x]) pts.push(y * W + x);
  const B = Math.max(2, Math.round(stroke * 0.75));
  const k = Math.max(2, Math.ceil((2.5 * stroke) / B));
  const TS = 2;
  const gapCells = Math.ceil(Math.max(2 * stroke, 6) / TS);
  const m = Math.max(1, Math.ceil((1.5 * stroke) / B));
  const out: RawLine[] = [];
  const corners = [[D.x, D.y], [D.x + D.w, D.y], [D.x, D.y + D.h], [D.x + D.w, D.y + D.h]];
  for (const horizontal of [true, false]) {
    const minLen = Math.max(0.3 * (horizontal ? D.w : D.h), 8 * stroke);
    for (let deg = -18; deg <= 18; deg += 2) {
      const ang = ((horizontal ? deg : 90 + deg) * Math.PI) / 180;
      const d = { x: Math.cos(ang), y: Math.sin(ang) }, n = { x: -d.y, y: d.x };
      let rLo = Infinity, rHi = -Infinity, tLo = Infinity, tHi = -Infinity;
      for (const [x, y] of corners) {
        const r = x * n.x + y * n.y, t = x * d.x + y * d.y;
        rLo = Math.min(rLo, r); rHi = Math.max(rHi, r); tLo = Math.min(tLo, t); tHi = Math.max(tHi, t);
      }
      const nb = Math.ceil((rHi - rLo) / B) + 1, nt = Math.ceil((tHi - tLo) / TS) + 1;
      const grid = new Uint8Array(nb * nt);
      const rowCount = new Int32Array(nb);
      // Pixels sorted by band bin (for the straightness check below).
      const binOf = new Int32Array(pts.length), start = new Int32Array(nb + 1), byBin = new Int32Array(pts.length);
      pts.forEach((i, j) => {
        const x = i % W, y = (i - x) / W;
        const bi = Math.floor((x * n.x + y * n.y - rLo) / B), ti = Math.floor((x * d.x + y * d.y - tLo) / TS);
        binOf[j] = bi;
        start[bi + 1]++;
        if (!grid[bi * nt + ti]) { grid[bi * nt + ti] = 1; rowCount[bi]++; }
      });
      for (let b = 0; b < nb; b++) start[b + 1] += start[b];
      const fillAt = start.slice(0, nb);
      pts.forEach((i, j) => (byBin[fillAt[binOf[j]]++] = i));
      const band = new Uint8Array(nt);
      for (let b = 0; b + k <= nb; b++) {
        let any = 0;
        for (let j = 0; j < k; j++) any += rowCount[b + j];
        if (any * TS < 0.75 * minLen) continue;
        band.fill(0);
        for (let j = 0; j < k; j++) {
          const off = (b + j) * nt;
          for (let t = 0; t < nt; t++) if (grid[off + t]) band[t] = 1;
        }
        let bs = -1, be = -1, bc = 0, s = -1, last = -1, cov = 0;
        const close = () => { if (s >= 0 && last - s > be - bs) { bs = s; be = last; bc = cov; } };
        for (let t = 0; t < nt; t++) {
          if (!band[t]) continue;
          if (s < 0 || t - last - 1 > gapCells) { close(); s = t; cov = 0; }
          cov++;
          last = t;
        }
        close();
        const len = (be - bs + 1) * TS;
        if (bs < 0 || len < minLen || bc / (be - bs + 1) < 0.75) continue;
        // A drawn line has paper just outside the band (bar where something joins it, or hatching on one side). A
        // band along a zigzag's axis or across a box's side catches strokes that carry on out of it on both sides.
        let both = 0, either = 0;
        for (let t = bs; t <= be; t++) {
          if (!band[t]) continue;
          let lo = false, hi = false;
          for (let j = 2; j <= m + 1 && !lo; j++) lo = b - j >= 0 && !!grid[(b - j) * nt + t];
          for (let j = 1; j <= m && !hi; j++) hi = b + k + j < nb && !!grid[(b + k + j) * nt + t];
          if (lo && hi) both++;
          if (lo || hi) either++;
        }
        if (both > 0.3 * bc) continue;
        // Straight: the ink's centre across the band follows a straight line (a zigzag's crossings wander across it).
        const ta = tLo + bs * TS, tb = tLo + (be + 1) * TS;
        const sum = new Float64Array(be - bs + 1), num = new Int32Array(be - bs + 1);
        for (let q = start[b]; q < start[b + k]; q++) {
          const i = byBin[q];
          const x = i % W, y = (i - x) / W;
          const rr = x * n.x + y * n.y;
          const ti = Math.floor((x * d.x + y * d.y - tLo) / TS) - bs;
          if (ti < 0 || ti > be - bs) continue;
          sum[ti] += rr;
          num[ti]++;
        }
        let sn = 0, st = 0, sr = 0, stt = 0, str = 0;
        for (let j = 0; j < num.length; j++) {
          if (!num[j]) continue;
          const mr = sum[j] / num[j];
          sn++; st += j; sr += mr; stt += j * j; str += j * mr;
        }
        const den = sn * stt - st * st;
        const slope = den ? (sn * str - st * sr) / den : 0, icpt = (sr - slope * st) / Math.max(1, sn);
        let rss = 0;
        for (let j = 0; j < num.length; j++) if (num[j]) rss += (sum[j] / num[j] - icpt - slope * j) ** 2;
        if (Math.sqrt(rss / Math.max(1, sn)) > 0.4 * stroke) continue;
        const ra = icpt, rb = icpt + slope * (be - bs);
        const a = { x: d.x * ta + n.x * ra, y: d.y * ta + n.y * ra }, e = { x: d.x * tb + n.x * rb, y: d.y * tb + n.y * rb };
        out.push({ kind: 'other', horizontal, a, b: e, len, deg: horizontal ? deg : 90 + deg, hatch: false, cov: (bc - either) * TS });
      }
    }
  }
  // One line per drawn stroke: the best-covered angle / band wins, overlapping neighbours are the same line.
  out.sort((p, q) => q.cov - p.cov);
  const kept: RawLine[] = [];
  for (const c of out) {
    const mid = { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 };
    const dup = kept.some((o) => {
      if (o.horizontal !== c.horizontal) return false;
      const n = normal(o);
      if (Math.abs((mid.x - o.a.x) * n.x + (mid.y - o.a.y) * n.y) > 3 * stroke) return false;
      const ux = (o.b.x - o.a.x) / o.len, uy = (o.b.y - o.a.y) / o.len;
      const p0 = (c.a.x - o.a.x) * ux + (c.a.y - o.a.y) * uy, p1 = (c.b.x - o.a.x) * ux + (c.b.y - o.a.y) * uy;
      const ov = Math.min(o.len, Math.max(p0, p1)) - Math.max(0, Math.min(p0, p1));
      return ov > 0.5 * Math.min(o.len, c.len);
    });
    if (!dup) kept.push(c);
  }
  return kept;
}

/**
 * Ink runs along the line at 1.5-4.5 pen widths off it, on one side, over a part of its length (0..1). A spring or
 * the sides of a block hanging off it give one or two; hatching gives a row of them.
 */
function sideRuns(l: PlanLine, ink: Uint8Array, W: number, H: number, sign: number, from: number, to: number, stroke: number) {
  const n = normal(l);
  const ux = (l.b.x - l.a.x) / l.len, uy = (l.b.y - l.a.y) / l.len;
  const o0 = 1.5 * stroke + 3, o1 = o0 + 3 * stroke;
  let runs = 0, prev = false, gap = 99;
  for (let t = from * l.len; t <= to * l.len; t += 1) {
    let on = false;
    for (let o = o0; o <= o1 && !on; o += 1) {
      const x = Math.round(l.a.x + ux * t + n.x * sign * o), y = Math.round(l.a.y + uy * t + n.y * sign * o);
      on = x >= 0 && y >= 0 && x < W && y < H && !!ink[y * W + x];
    }
    if (on && !prev && gap >= 2) runs++;
    gap = on ? 0 : gap + 1;
    prev = on;
  }
  return runs;
}

function classify(l: PlanLine, ink: Uint8Array, W: number, H: number, D: BBox, c: Point, stroke: number, total: number) {
  const inner = sideSign(l, c);
  const hangs = sideRuns(l, ink, W, H, inner, 0.1, 0.9, stroke) >= 1;
  l.hatch = sideRuns(l, ink, W, H, -inner, 0, 1, stroke) >= 4;
  if (!hangs) return;
  // A support is at the edge of the drawing: past its hatching (6 pen widths) there is next to no ink.
  const n = normal(l);
  let beyond = 0;
  for (let y = D.y; y < D.y + D.h; y++)
    for (let x = D.x; x < D.x + D.w; x++)
      if (ink[y * W + x] && -inner * ((x - l.a.x) * n.x + (y - l.a.y) * n.y) > 6 * stroke) beyond++;
  if (beyond > 0.1 * total) return;
  const mid = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
  if (l.horizontal) {
    const rel = (mid.y - D.y) / Math.max(1, D.h);
    if (rel <= 0.25) l.kind = 'ceiling';
    else if (rel >= 0.75) l.kind = 'floor';
  } else {
    const rel = (mid.x - D.x) / Math.max(1, D.w);
    if (rel <= 0.25 || rel >= 0.75) l.kind = 'wall';
  }
}

function eraseLine(ink: Uint8Array, W: number, H: number, l: PlanLine, r: number) {
  const ux = (l.b.x - l.a.x) / l.len, uy = (l.b.y - l.a.y) / l.len;
  const x0 = Math.max(0, Math.floor(Math.min(l.a.x, l.b.x) - r - 2)), x1 = Math.min(W - 1, Math.ceil(Math.max(l.a.x, l.b.x) + r + 2));
  const y0 = Math.max(0, Math.floor(Math.min(l.a.y, l.b.y) - r - 2)), y1 = Math.min(H - 1, Math.ceil(Math.max(l.a.y, l.b.y) + r + 2));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const t = (x - l.a.x) * ux + (y - l.a.y) * uy;
      if (t < -r || t > l.len + r) continue;
      if (Math.abs((x - l.a.x) * -uy + (y - l.a.y) * ux) <= r) ink[y * W + x] = 0;
    }
}

// ---- Block from the far end -----------------------------------------------------------------------------------

/**
 * The block drawn open or coloured in: walk in from the far end while the ink's two sides stay where the far edge put
 * them (within 2.5 pen widths); a stub or the spring's teeth move them. At least 3 pen widths long and 4 wide, and at
 * most 70% of the drawing along the axis.
 */
function endBand(rest: Uint8Array, W: number, H: number, vertical: boolean, plus: boolean, stroke: number, rejected: string[]): PlanMass | null {
  const n = vertical ? H : W;
  const lo = new Int32Array(n).fill(-1), hi = new Int32Array(n).fill(-1);
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i]) continue;
    const x = i % W, y = (i - x) / W;
    const u = vertical ? y : x, v = vertical ? x : y;
    if (lo[u] < 0 || v < lo[u]) lo[u] = v;
    if (v > hi[u]) hi[u] = v;
  }
  const us: number[] = [];
  for (let u = 0; u < n; u++) if (lo[u] >= 0) us.push(u);
  if (us.length < 3) return null;
  if (plus) us.reverse(); // us[0] = far end
  const first = us.slice(0, Math.max(2, Math.ceil(stroke)));
  const lo0 = Math.min(...first.map((u) => lo[u])), hi0 = Math.max(...first.map((u) => hi[u]));
  const width = hi0 - lo0 + 1;
  const tol = Math.max(2.5 * stroke, 0.12 * width);
  let lastGood = 0, moves = 0, rows = 0;
  for (let k = 1; k < us.length; k++) {
    const u = us[k];
    if (Math.abs(us[k] - us[lastGood]) > 3 * stroke + 1) break;
    if (Math.abs(lo[u] - lo0) <= tol && Math.abs(hi[u] - hi0) <= tol) {
      moves += (Math.abs(lo[u] - lo[us[k - 1]]) + Math.abs(hi[u] - hi[us[k - 1]])) / 2;
      rows++;
      lastGood = k;
    }
  }
  const length = Math.abs(us[lastGood] - us[0]) + 1;
  const extent = Math.abs(us[us.length - 1] - us[0]) + 1;
  const zig = rows ? moves / rows / stroke : 0;
  if (width < 4 * stroke || length < 3 * stroke || length > 0.7 * extent) {
    rejected.push(`far-end band ${width}×${length} (${width < 4 * stroke ? 'too thin' : length < 3 * stroke ? 'too short' : 'too long'})`);
    return null;
  }
  const u0 = Math.min(us[0], us[lastGood]), u1 = Math.max(us[0], us[lastGood]);
  const box = vertical ? { x: lo0, y: u0, w: width, h: u1 - u0 + 1 } : { x: u0, y: lo0, w: u1 - u0 + 1, h: width };
  return { box, kind: 'end', fill: 0, zig };
}

// ---- Shared pixel helpers ---------------------------------------------------------------------------------------

/** Enclosed paper regions (4-connected, not touching the image border). */
function enclosed(ink: Uint8Array, W: number, H: number): Hole[] {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out: Hole[] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || ink[s]) continue;
    let top = 0, n = 0, border = false, x0 = W, y0 = H, x1 = -1, y1 = -1;
    stack[top++] = s;
    seen[s] = 1;
    while (top) {
      const i = stack[--top];
      n++;
      const x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      if (x > 0 && !seen[i - 1] && !ink[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && !ink[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !seen[i - W] && !ink[i - W]) { seen[i - W] = 1; stack[top++] = i - W; }
      if (y < H - 1 && !seen[i + W] && !ink[i + W]) { seen[i + W] = 1; stack[top++] = i + W; }
    }
    if (border) continue;
    out.push({ x0, y0, x1, y1, area: n, fill: n / ((x1 - x0 + 1) * (y1 - y0 + 1)) });
  }
  return out;
}

/** Typical pen width: median over ink pixels of min(horizontal run, vertical run) through the pixel. */
export function strokeWidth(ink: Uint8Array, W: number, H: number): number {
  const hRun = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!ink[y * W + x]) { x++; continue; }
      let e = x;
      while (e < W && ink[y * W + e]) e++;
      for (let k = x; k < e; k++) hRun[y * W + k] = e - x;
      x = e;
    }
  }
  const hist = new Uint32Array(64);
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!ink[y * W + x]) { y++; continue; }
      let e = y;
      while (e < H && ink[e * W + x]) e++;
      for (let k = y; k < e; k++) hist[Math.min(63, Math.min(e - y, hRun[k * W + x]))]++;
      y = e;
    }
  }
  let total = 0;
  for (const v of hist) total += v;
  let acc = 0;
  for (let i = 0; i < 64; i++) if ((acc += hist[i]) >= total / 2) return Math.max(2, i);
  return 4;
}

// ---- Splitting one stroke group into block + spring (used by spring.ts) ----------------------------------------

/** Per-row (vertical axis) or per-column (horizontal axis) extent of a mask, in the axis frame (u along, v across). */
export function spans(mask: Uint8Array, W: number, H: number, vertical: boolean) {
  const n = vertical ? H : W;
  const lo = new Int32Array(n).fill(-1);
  const hi = new Int32Array(n).fill(-1);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const u = vertical ? y : x;
      const v = vertical ? x : y;
      if (lo[u] < 0 || v < lo[u]) lo[u] = v;
      if (v > hi[u]) hi[u] = v;
    }
  const width = (u: number) => (lo[u] < 0 ? 0 : hi[u] - lo[u] + 1);
  return { lo, hi, width, n };
}

export function centroidOf(mask: Uint8Array, W: number): Point | null {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      sx += i % W;
      sy += (i / W) | 0;
      n++;
    }
  return n ? { x: sx / n, y: sy / n } : null;
}

export const count = (mask: Uint8Array) => mask.reduce((s, v) => s + v, 0);

/**
 * Spring and block drawn as one stroke group (`mask` = its filled outline). With a plan that found the block, the
 * block is the band of rows (columns) the block covers along the plan's axis. Without one (old rule): the thick band
 * around the deepest point along the long axis. Everything else is the spring (and whatever fixed end is joined on).
 */
export function splitMerged(W: number, H: number, mask: Uint8Array, plan: SpringPlan | null) {
  const b = maskBounds(mask, W, H);
  if (!b) return null;
  const vertical = plan?.vertical ?? b.h >= b.w;
  const sp0 = spans(mask, W, H, vertical);
  let u0: number, u1: number;
  if (plan?.mass) {
    const m = plan.mass.box;
    // The block's outline lies outside a closed shape's paper region by about a pen width (+ the mask's margin).
    const pad = plan.mass.kind === 'closed' ? plan.stroke + 6 : 4;
    const m0 = vertical ? m.y : m.x, m1 = vertical ? m.y + m.h - 1 : m.x + m.w - 1;
    u0 = Math.max(0, m0 - pad);
    u1 = Math.min(sp0.n - 1, m1 + pad);
    // ...but not the stub of the spring joined to it: end rows much narrower than the block are left to the spring.
    let ref = 0;
    for (let u = Math.max(0, m0); u <= Math.min(sp0.n - 1, m1); u++) ref = Math.max(ref, sp0.width(u));
    while (u0 < m0 && sp0.width(u0) < 0.5 * ref) u0++;
    while (u1 > m1 && sp0.width(u1) < 0.5 * ref) u1--;
  } else {
    const { point } = deepestPoint(mask, W, H);
    const du = vertical ? point.y : point.x;
    const ref = sp0.width(du);
    if (!ref) return null;
    u0 = u1 = du;
    while (u0 > 0 && sp0.width(u0 - 1) >= 0.7 * ref) u0--;
    while (u1 < sp0.n - 1 && sp0.width(u1 + 1) >= 0.7 * ref) u1++;
  }
  const extent = vertical ? b.h : b.w;
  if (u1 - u0 + 1 > 0.85 * extent) return null;
  const mass = new Uint8Array(mask.length);
  const spring = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const u = vertical ? (i / W) | 0 : i % W;
    if (u >= u0 && u <= u1) mass[i] = 1;
    else spring[i] = 1;
  }
  if (count(spring) < 40 || count(mass) < 40) return null;
  return { mass, spring };
}

/** The spring's axis between a block and the spring ink: the plan's when it found a fixed end, else from the centres
 *  (horizontal only when clearly sideways: an unclear drawing is most likely a hanging spring). */
export function axisOf(plan: SpringPlan | null, cm: Point, cs: Point): boolean {
  if (plan && plan.vertical !== null) return plan.vertical;
  return Math.abs(cm.x - cs.x) <= 1.5 * Math.abs(cm.y - cs.y) || Math.abs(cm.x - cs.x) < 1;
}

/**
 * True if the non-block part of a split looks like a spring hanging off one side of the block
 * (not a floor/wall line running past it): it sits on one side and is centred across the block.
 */
export function looksLikeSpring(W: number, H: number, split: { mass: Uint8Array; spring: Uint8Array }, plan: SpringPlan | null): boolean {
  const mb = maskBounds(split.mass, W, H);
  const cm = centroidOf(split.mass, W);
  const cs = centroidOf(split.spring, W);
  if (!mb || !cm || !cs) return false;
  const vertical = axisOf(plan, cm, cs);
  let before = 0, after = 0;
  for (let i = 0; i < split.spring.length; i++) {
    if (!split.spring[i]) continue;
    const u = vertical ? (i / W) | 0 : i % W;
    const c = vertical ? mb.y + mb.h / 2 : mb.x + mb.w / 2;
    if (u < c) before++;
    else after++;
  }
  const oneSided = Math.max(before, after) >= 0.85 * (before + after);
  const off = vertical ? Math.abs(cs.x - cm.x) / Math.max(1, mb.w) : Math.abs(cs.y - cm.y) / Math.max(1, mb.h);
  return oneSided && off < 0.35;
}

/** Zigzag-ness of a contour outline: its length over its convex hull's perimeter (a box or circle ~1, a zigzag 2+). */
export function outlineZig(points: Point[], hull: Point[]): number {
  const per = (p: Point[]) => p.reduce((s, q, i) => s + Math.hypot(q.x - p[(i + 1) % p.length].x, q.y - p[(i + 1) % p.length].y), 0);
  const h = per(hull);
  return h > 0 ? per(points) / h : 1;
}
