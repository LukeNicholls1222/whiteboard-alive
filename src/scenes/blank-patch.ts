// Safety net for a photo where vision found no lines at all (very faint pencil, an odd photo, blank paper): which part
// of the photo falls. Pure (luma in, rectangle out) so node can test it.
//
// Not "the darkest part": a phone or hand shadow is far darker than faint pencil and used to be picked. Instead the
// most line-like marks win: thin (narrower than a small background window) and with paper on both sides.
//   1. Background = close (max then min) over a small window: thin marks vanish from it, a shadow stays (it is wide).
//      mark = background - luma -> a shadow's inside and its straight edges are ~0, a pencil line keeps its depth.
//   2. Marks above the paper noise, grouped into 8-connected pieces. A piece counts if it is long enough, thin, and
//      the pixels just outside it are paper (not as dark as the piece: that is a shadow's corner or edge).
//   3. The square window (40 % of the short side) holding the most mark weight of those pieces, preferring the middle
//      and keeping off the photo edges, tightened to those pieces. Nothing found: the middle of the photo.

export interface Patch {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Background window half-size (ratio of the short side): wider than a (blurry) pencil line, far narrower than a shadow. */
const BG_HALF = 0.012;
/** Mark threshold: this many times the 90th percentile of the mark (paper noise), at least MIN_DEPTH luma levels. */
const OVER_NOISE = 3;
const MIN_DEPTH = 4;
/** A piece must be at least this long (bounding-box diagonal, ratio of the short side)... */
const MIN_LONG = 0.04;
/** ...and at most this thick on average (pixels / length, ratio of the short side; a box outline reads ~3x its stroke). */
const MAX_WIDTH = 0.02;
/** Ring test: look this far (ratio) outside the piece; reject if more than RING_DARK of those pixels are about as dark
 * as the piece and clearly darker than the paper (by RING_DEPTH). */
const RING_STEP = 0.006;
const RING_DARK = 0.3;
const RING_DEPTH = 0.08;
/** Window side and edge margin (ratios of the short side). */
const WINDOW = 0.4;
const MARGIN = 0.05;
/** Below this window weight (sum of luma levels over the threshold, per px of the short side; ~ a line a third of the
 * short side long and a few levels deep) nothing line-like is there: the middle. */
const MIN_SCORE = 3;

/** Sliding max (or min) over 2r+1 along rows, then along columns. */
function filter2(src: Uint8Array, W: number, H: number, r: number, max: boolean): Uint8Array {
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  const pick = max ? (a: number, b: number) => (a > b ? a : b) : (a: number, b: number) => (a < b ? a : b);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) {
      let v = src[o + x];
      for (let k = Math.max(0, x - r), e = Math.min(W - 1, x + r); k <= e; k++) v = pick(v, src[o + k]);
      tmp[o + x] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = tmp[y * W + x];
      for (let k = Math.max(0, y - r), e = Math.min(H - 1, y + r); k <= e; k++) v = pick(v, tmp[k * W + x]);
      out[y * W + x] = v;
    }
  }
  return out;
}

/**
 * Value at the given fraction of the sorted values, over the middle of the photo (20-80 % each way: mostly paper, so a
 * textured desk around the sheet does not raise the noise level over faint pencil), every 3rd pixel.
 */
function percentile(a: Uint8Array, W: number, H: number, p: number): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = Math.floor(H * 0.2); y < H * 0.8; y++)
    for (let i = y * W + Math.floor(W * 0.2) + (y % 3), end = y * W + W * 0.8; i < end; i += 3) { hist[a[i]]++; n++; }
  for (let t = 0, acc = 0; t < 256; t++) if ((acc += hist[t]) >= n * p) return t;
  return 255;
}

export function linePatch(luma: Uint8Array, W: number, H: number, log?: (msg: string) => void): Patch {
  const N = W * H, minSide = Math.min(W, H);
  const side = Math.round(minSide * WINDOW), margin = Math.round(minSide * MARGIN);
  const middle = { x: Math.round((W - side) / 2), y: Math.round((H - side) / 2), w: side, h: side };

  // 1. Thin marks against a small-window background.
  const r = Math.max(3, Math.round(minSide * BG_HALF));
  const bg = filter2(filter2(luma, W, H, r, true), W, H, r, false);
  const mark = new Uint8Array(N);
  for (let i = 0; i < N; i++) mark[i] = bg[i] > luma[i] ? bg[i] - luma[i] : 0;
  const thr = Math.max(MIN_DEPTH, percentile(mark, W, H, 0.9) * OVER_NOISE);
  const paperL = percentile(luma, W, H, 0.9);
  const shadowL = paperL * (1 - RING_DEPTH);

  // 2. Pieces (8-connected), each judged on length, thickness and its ring.
  const label = new Int32Array(N).fill(-1);
  const keep = new Uint8Array(N);
  const stack: number[] = [];
  const ringStep = Math.max(2, Math.round(minSide * RING_STEP));
  const minLong = minSide * MIN_LONG, maxWidth = Math.max(4, minSide * MAX_WIDTH);
  let pieces = 0, kept = 0, shadows = 0;
  const px: number[] = [];
  for (let s = 0; s < N; s++) {
    if (mark[s] < thr || label[s] >= 0) continue;
    px.length = 0;
    label[s] = pieces;
    stack.push(s);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    while (stack.length) {
      const i = stack.pop()!;
      px.push(i);
      const x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (label[j] < 0 && mark[j] >= thr) { label[j] = pieces; stack.push(j); }
        }
      }
    }
    pieces++;
    const long = Math.hypot(x1 - x0 + 1, y1 - y0 + 1);
    if (long < minLong || px.length / long > maxWidth) continue;
    // Ring: a few px outside the piece in the four directions.
    let ring = 0, dark = 0;
    for (const i of px) {
      const x = i % W, y = (i - x) / W;
      for (const [dx, dy] of [[ringStep, 0], [-ringStep, 0], [0, ringStep], [0, -ringStep]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (mark[j] >= thr) continue;
        ring++;
        if (luma[j] <= shadowL && luma[j] < luma[i] + 0.5 * mark[i]) dark++;
      }
    }
    if (ring && dark > ring * RING_DARK) { shadows++; continue; }
    kept++;
    for (const i of px) keep[i] = 1;
  }

  // 3. Best window over the kept pieces' weight (integral image).
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (keep[i]) row += mark[i] - thr + 1;
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const sum = (x: number, y: number, w: number, h: number) =>
    S[(y + h) * (W + 1) + x + w] - S[y * (W + 1) + x + w] - S[(y + h) * (W + 1) + x] + S[y * (W + 1) + x];
  let best = middle, bestScore = 0;
  const far = Math.hypot(W, H) / 2;
  for (let y = margin; y + side <= H - margin; y += 8)
    for (let x = margin; x + side <= W - margin; x += 8) {
      const off = Math.hypot(x + side / 2 - W / 2, y + side / 2 - H / 2) / far;
      const score = sum(x, y, side, side) * (1 - 0.5 * off);
      if (score > bestScore) { bestScore = score; best = { x, y, w: side, h: side }; }
    }
  const summary = `noise threshold ${thr}, ${pieces} pieces, ${kept} line-like, ${shadows} shadow edges skipped`;
  if (bestScore < minSide * MIN_SCORE) {
    log?.(`${summary}: nothing line-like, the middle of the photo falls`);
    return middle;
  }
  // Tighten to the kept marks in the window, keeping a little paper around them and a sensible size.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = best.y; y < best.y + best.h; y++)
    for (let x = best.x; x < best.x + best.w; x++)
      if (keep[y * W + x]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  if (x1 < 0) return best;
  const pad = Math.round(minSide * 0.03), minW = Math.round(minSide * 0.15);
  const grow = (lo: number, hi: number, limit: number) => {
    let a = lo - pad, b = hi + pad;
    if (b - a < minW) { const c = (a + b) / 2; a = c - minW / 2; b = c + minW / 2; }
    a = Math.max(0, Math.round(a));
    b = Math.min(limit, Math.round(b));
    return [a, b - a] as const;
  };
  const [x, w] = grow(x0, x1, W), [y, h] = grow(y0, y1, H);
  log?.(`${summary}: marks at [${x},${y} ${w}x${h}] fall`);
  return { x, y, w, h };
}
