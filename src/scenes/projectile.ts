// Projectile: the drawn ball flies along a parabola from where it was drawn, in the direction of the
// drawn arrow (or cannon barrel), leaving a dotted trail. Lands, waits 1.5 s, and fires again.
//
// Works without AI roles: the ball is found as a small round closed loop (or a filled dot) in the ink,
// the arrow as a long thin stroke starting at the ball, the barrel as the ink right next to the ball.
// Everything else that was drawn (ground, cliff, cannon) stays in the background and becomes static
// collision cells, so the ball lands on what was actually drawn.

import Matter from 'matter-js';
import type { Contour, PartInfo, PartName, Point, SceneBuilder, SceneInput, Sprite, ValueSource } from '../types';
import { contourMask, cutSprite, eraseFromPaper, maskBounds, roleOf } from './common';
import { STEP_ACCEL, STEP_MS } from '../sim';
import { DEFAULT_KG, EARTH_G, mps, noteFor, pxPerStep, scaleFor } from '../units';
import { dragConstant, roundFactor } from '../air';

const RELAUNCH_MS = 1500;
/** Minimum elevation when the ball starts on the ground (a flat shot would just roll). */
const MIN_ELEV_GROUND_DEG = 15;
/** Minimum elevation when there is a drop below the ball (a horizontal shot off a cliff is still an arc). */
const MIN_ELEV_DROP_DEG = 0;
const MAX_ELEV_DEG = 80;
const DEFAULT_ELEV_DEG = 45;
const TRAIL_EVERY = 2; // steps between trail samples
/** Collision cell size (px) for the drawn scenery. */
const CELL = 5;
/** Give up on a flight after this long and fire again (never leave the scene stuck). */
const MAX_FLIGHT_MS = 9000;
/**
 * Drag the air switch aims for: drag = this × weight at the fitted launch speed (the one that lands inside the
 * picture). The arc then visibly leans (steeper fall than rise) and lands clearly short.
 */
const AIR_DRAG_TARGET = 0.6;
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

interface Axis {
  centroid: Point;
  /** Unit vector of the long axis. */
  dir: Point;
  /** Extreme projections of the ink along dir (min < 0 < max). */
  min: number;
  max: number;
  /** Long/short spread ratio; ~1 means no clear direction. */
  elongation: number;
  pixels: Point[];
}

interface Ball {
  center: Point;
  /** Outer radius of the drawn ball (including its outline stroke). */
  r: number;
  /** Outline stroke width. */
  stroke: number;
  /** Pixels belonging to the ball (cut out as the sprite, erased from the background). */
  mask: Uint8Array;
}

/** Principal axis of a pixel set. */
function axisOf(pixels: Point[]): Axis | null {
  if (pixels.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of pixels) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pixels.length;
  cy /= pixels.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pixels) {
    const dx = p.x - cx, dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dir = { x: Math.cos(theta), y: Math.sin(theta) };
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  let min = Infinity, max = -Infinity;
  for (const p of pixels) {
    const t = (p.x - cx) * dir.x + (p.y - cy) * dir.y;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return { centroid: { x: cx, y: cy }, dir, min, max, elongation: Math.sqrt(l1 / l2), pixels };
}

/** Principal axis of the ink pixels inside the given contours' mask. */
function inkAxis(input: SceneInput, contours: Contour[]): Axis | null {
  const { width: W, height: H } = input;
  const mask = contourMask(input, contours, 2);
  const b = maskBounds(mask, W, H);
  if (!b) return null;
  const pixels: Point[] = [];
  // Prefer actual ink; fall back to the filled mask if the ink mask is empty there.
  for (const useInk of [true, false]) {
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = y * W + x;
        if (mask[i] && (!useInk || input.ink[i])) pixels.push({ x, y });
      }
    if (pixels.length >= 10) break;
  }
  return axisOf(pixels);
}

/** Arrow: the head end is the one whose ink spreads widest across the shaft (the barbs). */
function arrowDirection(ax: Axis): Point {
  const len = ax.max - ax.min;
  const zone = len * 0.3;
  let spreadMin = 0, spreadMax = 0;
  for (const p of ax.pixels) {
    const dx = p.x - ax.centroid.x, dy = p.y - ax.centroid.y;
    const t = dx * ax.dir.x + dy * ax.dir.y;
    const n = Math.abs(-dx * ax.dir.y + dy * ax.dir.x);
    if (t > ax.max - zone) spreadMax = Math.max(spreadMax, n);
    if (t < ax.min + zone) spreadMin = Math.max(spreadMin, n);
  }
  if (Math.abs(spreadMax - spreadMin) < 1) return upward(ax.dir); // can't tell: assume it points up-ish
  return spreadMax >= spreadMin ? ax.dir : { x: -ax.dir.x, y: -ax.dir.y };
}

/** Pick the sign of an axis that points up (screen y decreases); near-horizontal -> rightwards. */
function upward(d: Point): Point {
  if (Math.abs(d.y) < 0.1) return d.x >= 0 ? d : { x: -d.x, y: -d.y };
  return d.y < 0 ? d : { x: -d.x, y: -d.y };
}

/** Keep the launch between min and MAX elevation so there is always a visible arc. */
function clampElevation(d: Point, minDeg: number): number {
  const right = d.x >= 0;
  let elev = (Math.atan2(-d.y, Math.abs(d.x)) * 180) / Math.PI;
  if (!Number.isFinite(elev)) elev = DEFAULT_ELEV_DEG;
  elev = Math.min(MAX_ELEV_DEG, Math.max(minDeg, elev));
  const rad = (elev * Math.PI) / 180;
  return right ? -rad : Math.PI + rad; // screen-space angle of the velocity
}

/** A small marker-drawn ball for when no projectile was drawn. */
function drawnBall(r: number): HTMLCanvasElement {
  const pad = Math.ceil(r * 0.4) + 2;
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(2 * (r + pad));
  const ctx = c.getContext('2d')!;
  const cx = c.width / 2, cy = c.height / 2;
  const wobble = (seed: number, rr: number) => {
    ctx.beginPath();
    const n = 28;
    for (let i = 0; i <= n + 2; i++) {
      const a = (i / n) * Math.PI * 2 + seed;
      const k = rr * (1 + 0.06 * Math.sin(a * 3 + seed * 5) + 0.03 * Math.sin(a * 7 + seed));
      const x = cx + Math.cos(a) * k, y = cy + Math.sin(a) * k;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
  };
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.fillStyle = 'rgba(28,28,32,0.82)';
  wobble(0.7, r * 0.92);
  ctx.fill();
  ctx.strokeStyle = '#1c1c20';
  ctx.lineWidth = Math.max(2, r * 0.2);
  wobble(1.9, r * 0.95);
  ctx.stroke();
  return c;
}

// ---- Ball detection ---------------------------------------------------------------------------

/** Square dilation of a binary mask by d px (separable max filter). */
function dilate(src: Uint8Array, W: number, H: number, d: number): Uint8Array {
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let last = -1e9;
    for (let x = 0; x < W; x++) {
      if (src[row + x]) last = x;
      if (x - last <= d) tmp[row + x] = 1;
    }
    last = 1e9;
    for (let x = W - 1; x >= 0; x--) {
      if (src[row + x]) last = x;
      if (last - x <= d) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let last = -1e9;
    for (let y = 0; y < H; y++) {
      if (tmp[y * W + x]) last = y;
      if (y - last <= d) out[y * W + x] = 1;
    }
    last = 1e9;
    for (let y = H - 1; y >= 0; y--) {
      if (tmp[y * W + x]) last = y;
      if (last - y <= d) out[y * W + x] = 1;
    }
  }
  return out;
}

function discMask(W: number, H: number, c: Point, r: number): Uint8Array {
  const m = new Uint8Array(W * H);
  const x0 = Math.max(0, Math.floor(c.x - r)), x1 = Math.min(W - 1, Math.ceil(c.x + r));
  const y0 = Math.max(0, Math.floor(c.y - r)), y1 = Math.min(H - 1, Math.ceil(c.y + r));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) if ((x - c.x) ** 2 + (y - c.y) ** 2 <= r * r) m[y * W + x] = 1;
  return m;
}

/** Width of the ink ring around a hole: median run of ink met when walking outwards from the centre. */
function ringStroke(ink: Uint8Array, W: number, H: number, c: Point, rHole: number): number {
  const runs: number[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    let t = Math.max(0, rHole - 3);
    const tMax = rHole * 2 + 20;
    // find the ring
    while (t < tMax) {
      const x = Math.round(c.x + dx * t), y = Math.round(c.y + dy * t);
      if (x < 0 || y < 0 || x >= W || y >= H) break;
      if (ink[y * W + x]) break;
      t++;
    }
    let run = 0;
    while (t < tMax) {
      const x = Math.round(c.x + dx * t), y = Math.round(c.y + dy * t);
      if (x < 0 || y < 0 || x >= W || y >= H || !ink[y * W + x]) break;
      run++;
      t++;
    }
    if (run > 0) runs.push(run);
  }
  if (!runs.length) return 3;
  runs.sort((a, b) => a - b);
  return Math.max(2, Math.min(rHole * 0.6, runs[Math.floor(runs.length / 2)]));
}

interface HoleCand {
  center: Point;
  /** Radius of the hole in the original (undilated) ink. */
  r: number;
  /** Ink inside the hole (e.g. the axle dot of a wheel). */
  hasInner: boolean;
}

/** Round, enclosed paper regions in the (slightly dilated, to bridge pen gaps) ink. */
function roundHoles(ink: Uint8Array, W: number, H: number, d: number): HoleCand[] {
  const m = d > 0 ? dilate(ink, W, H, d) : ink;
  const minDim = Math.min(W, H);
  const rMin = Math.max(5, minDim * 0.011);
  const rMax = minDim * 0.2;
  const maxArea = Math.PI * (rMax + d) ** 2 * 1.5;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out: HoleCand[] = [];
  for (let s = 0; s < W * H; s++) {
    if (m[s] || seen[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    let area = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    let border = false;
    while (sp) {
      const i = stack[--sp];
      const x = i % W, y = (i / W) | 0;
      area++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      if (x > 0 && !m[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (stack[sp++] = i - 1);
      if (x < W - 1 && !m[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (stack[sp++] = i + 1);
      if (y > 0 && !m[i - W] && !seen[i - W]) (seen[i - W] = 1), (stack[sp++] = i - W);
      if (y < H - 1 && !m[i + W] && !seen[i + W]) (seen[i + W] = 1), (stack[sp++] = i + W);
    }
    if (border || area > maxArea) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const aspect = w / h;
    if (aspect < 0.65 || aspect > 1.55) continue;
    const fill = area / ((Math.PI / 4) * w * h);
    if (fill < 0.78 || fill > 1.12) continue;
    const r = Math.sqrt(area / Math.PI) + d;
    if (r < rMin || r > rMax) continue;
    const center = { x: sx / area, y: sy / area };
    // Ink inside the hole's central region means it is a wheel with an axle, a target, etc.
    let hasInner = false;
    const ix0 = Math.round(x0 + w * 0.2), ix1 = Math.round(x1 - w * 0.2);
    const iy0 = Math.round(y0 + h * 0.2), iy1 = Math.round(y1 - h * 0.2);
    for (let y = iy0; y <= iy1 && !hasInner; y++) for (let x = ix0; x <= ix1; x++) if (ink[y * W + x]) {
      hasInner = true;
      break;
    }
    out.push({ center, r, hasInner });
  }
  return out;
}

/** True if p lies inside the closed polygon. */
function insidePoly(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function makeBall(input: SceneInput, center: Point, rHole: number, stroke: number): Ball {
  const { width: W, height: H, ink } = input;
  const r = rHole + stroke;
  const mask = discMask(W, H, center, r + 2);
  // Uneven pen pressure makes the ring thicker in places: take that ink too.
  const outer = r + stroke * 0.6 + 2;
  for (let y = Math.max(0, Math.floor(center.y - outer)); y <= Math.min(H - 1, Math.ceil(center.y + outer)); y++)
    for (let x = Math.max(0, Math.floor(center.x - outer)); x <= Math.min(W - 1, Math.ceil(center.x + outer)); x++) {
      const i = y * W + x;
      if (ink[i] && (x - center.x) ** 2 + (y - center.y) ** 2 <= outer * outer) mask[i] = 1;
    }
  // A line passing under the ball (ground, cliff top) is merged with its outline. Find where the line
  // leaves the ball on the left/right and keep that band in the background, so no gap opens in it.
  const exitAt = (x: number) => {
    if (x < 0 || x >= W) return null;
    let top = -1;
    for (let y = Math.round(center.y + r * 0.3); y <= Math.min(H - 1, center.y + r + 3 * stroke); y++) {
      const on = ink[y * W + x];
      if (on && top < 0) top = y;
      if (!on && top >= 0) {
        if ((top + y - 1) / 2 > center.y + r * 0.4) return { mid: (top + y - 1) / 2, half: (y - top) / 2 };
        top = -1;
      }
    }
    return null;
  };
  const L = exitAt(Math.round(center.x - r - 3));
  const R = exitAt(Math.round(center.x + r + 3));
  if (L || R) {
    const x0 = center.x - r - 3, x1 = center.x + r + 3;
    const half = Math.max(L?.half ?? 0, R?.half ?? 0) + 1.5;
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(W - 1, Math.ceil(x1)); x++) {
      const k = (x - x0) / (x1 - x0);
      const mid = L && R ? L.mid + (R.mid - L.mid) * k : (L ?? R)!.mid;
      for (let y = Math.max(0, Math.floor(mid - half)); y <= Math.min(H - 1, Math.ceil(mid + half)); y++) {
        const i = y * W + x;
        if (ink[i]) mask[i] = 0;
      }
    }
  }
  return { center, r, stroke, mask };
}

/** Find the drawn ball: AI role first, then a round closed loop, then a filled round dot. */
function findBall(input: SceneInput, labelled: Contour[]): Ball | null {
  const { width: W, height: H, ink } = input;
  if (labelled.length) {
    const mask = contourMask(input, labelled);
    const b = maskBounds(mask, W, H);
    if (b) {
      const r = Math.max(6, Math.max(b.w, b.h) / 2);
      return { center: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, r, stroke: Math.max(2, r * 0.15), mask };
    }
  }
  // Round closed loops. Bridge small pen gaps by dilating a little more on each try.
  for (const d of [2, 4]) {
    const holes = roundHoles(ink, W, H, d);
    if (!holes.length) continue;
    // Prefer empty loops (a wheel has an axle), then the smallest (a ball is drawn smaller than wheels).
    holes.sort((a, b) => Number(a.hasInner) - Number(b.hasInner) || a.r - b.r);
    const h = holes[0];
    return makeBall(input, h.center, h.r, ringStroke(ink, W, H, h.center, h.r));
  }
  // Filled dot: a small, compact, solid contour that is not drawn inside something else.
  const minDim = Math.min(W, H);
  const dots = input.contours.filter((c) => {
    const { w, h } = c.bbox;
    const size = Math.max(w, h);
    if (size < minDim * 0.02 || size > minDim * 0.15) return false;
    if (w / h < 0.6 || w / h > 1.65) return false;
    if (c.inkPixels / (w * h) < 0.5) return false;
    return !input.contours.some((o) => o !== c && o.points.length > 2 && insidePoly(c.centroid, o.points));
  });
  if (dots.length) {
    const c = dots.reduce((a, b) => (b.inkPixels > a.inkPixels ? b : a));
    const r = Math.max(c.bbox.w, c.bbox.h) / 2;
    const center = { x: c.bbox.x + c.bbox.w / 2, y: c.bbox.y + c.bbox.h / 2 };
    return { center, r, stroke: r, mask: discMask(W, H, center, r + 1.5) };
  }
  return null;
}

// ---- Arrow / barrel near the ball -------------------------------------------------------------

/** 8-connected ink components (outside `exclude`) as pixel lists; tiny specks are dropped. */
function inkComponents(ink: Uint8Array, exclude: Uint8Array, W: number, H: number, minPx: number): Point[][] {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const comps: Point[][] = [];
  for (let s = 0; s < W * H; s++) {
    if (!ink[s] || exclude[s] || seen[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    const px: Point[] = [];
    while (sp) {
      const i = stack[--sp];
      const x = i % W, y = (i / W) | 0;
      px.push({ x, y });
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (ink[j] && !exclude[j] && !seen[j]) {
            seen[j] = 1;
            stack[sp++] = j;
          }
        }
    }
    if (px.length >= minPx) comps.push(px);
  }
  return comps;
}

/** A long thin stroke that starts at the ball and whose line passes through it. Returns direction + its pixels. */
function arrowFromBall(ball: Ball, comps: Point[][]): { dir: Point; pixels: Point[] } | null {
  const R = ball.r;
  let best: { dir: Point; pixels: Point[]; score: number } | null = null;
  for (const px of comps) {
    let dmin = Infinity;
    for (const p of px) dmin = Math.min(dmin, Math.hypot(p.x - ball.center.x, p.y - ball.center.y));
    if (dmin > R + 4 + Math.max(2 * R, 25)) continue;
    const ax = axisOf(px);
    if (!ax || ax.elongation < 4) continue;
    const len = ax.max - ax.min;
    if (len < 1.5 * R) continue;
    const bx = ball.center.x - ax.centroid.x, by = ball.center.y - ax.centroid.y;
    const tBall = bx * ax.dir.x + by * ax.dir.y;
    const perp = Math.abs(-bx * ax.dir.y + by * ax.dir.x);
    if (perp > 0.7 * R) continue; // the ball is not on this line (e.g. the ground it sits on)
    // The ball must sit at one end of the stroke, not in the middle of it.
    const atMin = tBall < ax.min + 0.5 * R;
    const atMax = tBall > ax.max - 0.5 * R;
    if (!atMin && !atMax) continue;
    const dir = atMin ? ax.dir : { x: -ax.dir.x, y: -ax.dir.y };
    // A launch arrow does not point steeply downwards.
    if (-dir.y < -0.35) continue;
    const score = perp / R - len / (10 * R);
    if (!best || score < best.score) best = { dir, pixels: px, score };
  }
  return best;
}

/** Barrel direction: from the drawing right behind the ball towards the ball, refined by the barrel's axis. */
function barrelFromBall(ball: Ball, ink: Uint8Array, exclude: Uint8Array, W: number, H: number): Point | null {
  const R = ball.r;
  const reach = Math.max(6 * R, 80);
  const px: Point[] = [];
  const x0 = Math.max(0, Math.floor(ball.center.x - reach)), x1 = Math.min(W - 1, Math.ceil(ball.center.x + reach));
  const y0 = Math.max(0, Math.floor(ball.center.y - reach)), y1 = Math.min(H - 1, Math.ceil(ball.center.y + reach));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (ink[i] && !exclude[i] && (x - ball.center.x) ** 2 + (y - ball.center.y) ** 2 <= reach * reach) px.push({ x, y });
    }
  if (px.length < 20) return null;
  const ax = axisOf(px)!;
  const to = { x: ball.center.x - ax.centroid.x, y: ball.center.y - ax.centroid.y };
  const n = Math.hypot(to.x, to.y);
  if (n < 1) return null;
  const toU = { x: to.x / n, y: to.y / n };
  // Flat ink straight below the ball: that is the ground it sits on, not a cannon.
  if (toU.y < -0.85 && Math.abs(ax.dir.y) < 0.3) return null;
  // Use the barrel's axis only when it really points at the ball (not e.g. along the muzzle lip).
  if (ax.elongation > 1.5) {
    const along = toU.x * ax.dir.x + toU.y * ax.dir.y;
    if (Math.abs(along) > 0.8) return along >= 0 ? ax.dir : { x: -ax.dir.x, y: -ax.dir.y };
  }
  return toU;
}

// ---- Scenery ----------------------------------------------------------------------------------

/** Static collision cells covering the drawn ink (minus `exclude`), merged into horizontal runs. */
function sceneryBodies(ink: Uint8Array, exclude: Uint8Array, W: number, H: number): Matter.Body[] {
  const cols = Math.ceil(W / CELL), rows = Math.ceil(H / CELL);
  const bodies: Matter.Body[] = [];
  for (let cy = 0; cy < rows; cy++) {
    let runStart = -1;
    for (let cx = 0; cx <= cols; cx++) {
      let on = false;
      if (cx < cols) {
        let k = 0;
        for (let y = cy * CELL; y < Math.min(H, cy * CELL + CELL) && !on; y++)
          for (let x = cx * CELL; x < Math.min(W, cx * CELL + CELL); x++) {
            const i = y * W + x;
            if (ink[i] && !exclude[i] && ++k >= 3) {
              on = true;
              break;
            }
          }
      }
      if (on && runStart < 0) runStart = cx;
      if (!on && runStart >= 0) {
        const x0 = runStart * CELL, x1 = Math.min(W, cx * CELL);
        const y0 = cy * CELL, y1 = Math.min(H, y0 + CELL);
        bodies.push(
          Matter.Bodies.rectangle((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, { isStatic: true, friction: 0.9 }),
        );
        runStart = -1;
      }
    }
  }
  return bodies;
}

/** Left and right end of the ink just above `floorY` (the drawn ground line's length), outside `exclude`. */
function groundSpan(ink: Uint8Array, exclude: Uint8Array, W: number, H: number, floorY: number): { x0: number; x1: number } | null {
  const band = Math.max(8, Math.round(H * 0.04));
  let x0 = W, x1 = -1;
  for (let y = Math.max(0, Math.floor(floorY - band)); y <= Math.min(H - 1, Math.ceil(floorY + 2)); y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!ink[i] || exclude[i]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
  return x1 > x0 ? { x0, x1 } : null;
}

/** Lowest long, roughly horizontal band of ink below `belowY` (the ground). Returns the lowest ink y in it. */
function groundLine(ink: Uint8Array, W: number, H: number, belowY: number): number | null {
  const band = Math.max(8, Math.round(H * 0.04));
  const bins = Math.ceil(W / 8);
  for (let y0 = H - band; y0 >= Math.max(0, Math.floor(belowY)); y0 -= 4) {
    const hit = new Uint8Array(bins);
    let lowest = -1;
    for (let y = y0; y < y0 + band; y++)
      for (let x = 0; x < W; x++)
        if (ink[y * W + x]) {
          hit[x >> 3] = 1;
          lowest = Math.max(lowest, y);
        }
    let n = 0;
    for (const v of hit) n += v;
    if (n >= bins * 0.25) return lowest;
  }
  return null;
}

// ---- Scene ------------------------------------------------------------------------------------

export const buildProjectile: SceneBuilder = (input) => {
  const { width: W, height: H, ink } = input;
  const byRole = (...roles: string[]) =>
    input.contours.filter((c) => {
      const r = roleOf(input, c.id);
      return !!r && roles.includes(r.role);
    });

  const balls = byRole('projectile');
  const grounds = byRole('ground', 'incline');
  const cannons = byRole('cannon');
  const arrows = byRole('arrow');

  const ball = findBall(input, balls);
  const exclude = ball ? new Uint8Array(ball.mask) : new Uint8Array(W * H);

  // --- Launch direction ---
  let dir: Point | null = null;
  let launch: Point | null = null; // only used when no ball was drawn
  if (arrows.length) {
    const ax = inkAxis(input, [arrows.reduce((a, b) => (b.area + b.inkPixels > a.area + a.inkPixels ? b : a))]);
    if (ax && ax.elongation > 1.5) {
      dir = arrowDirection(ax);
      const tail = dir.x * ax.dir.x + dir.y * ax.dir.y > 0 ? ax.min : ax.max; // opposite end to the head
      launch = { x: ax.centroid.x + ax.dir.x * tail, y: ax.centroid.y + ax.dir.y * tail };
    }
    // The arrow is a hint, not scenery.
    const am = contourMask(input, arrows, 3);
    for (let i = 0; i < am.length; i++) if (am[i]) exclude[i] = 1;
  }
  if (ball && !dir) {
    // Ink split into strokes once the ball is cut out (the arrow is often drawn touching the ball).
    // Cut only the ball's disc (not its full sprite mask), so the root of an arrow stays part of the arrow.
    const cut = discMask(W, H, ball.center, ball.r + 3);
    const comps = inkComponents(ink, cut, W, H, 15);
    const arrow = arrowFromBall(ball, comps);
    if (arrow) {
      dir = arrow.dir;
      for (const p of arrow.pixels) {
        exclude[p.y * W + p.x] = 1;
        ball.mask[p.y * W + p.x] = 0; // the arrow stays drawn on the paper, it does not fly with the ball
      }
    } else {
      dir = barrelFromBall(ball, ink, cut, W, H);
    }
  }
  if (!dir && cannons.length) {
    let best: Axis | null = null;
    for (const c of cannons) {
      const ax = inkAxis(input, [c]);
      if (ax && (!best || ax.elongation > best.elongation)) best = ax;
    }
    if (best) {
      if (best.elongation > 1.4) dir = upward(best.dir);
      const d = dir ?? { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
      let far = -Infinity;
      for (const p of best.pixels) {
        const t = (p.x - best.centroid.x) * d.x + (p.y - best.centroid.y) * d.y;
        if (t > far) {
          far = t;
          launch = p; // muzzle = farthest ink along the firing direction
        }
      }
    }
  }

  // --- The ball: the drawn one, otherwise a marker-style dot at the arrow tail / muzzle ---
  const r = ball ? ball.r : Math.max(8, Math.round(Math.min(W, H) * 0.022));
  let start: Point;
  if (ball) start = { ...ball.center };
  else {
    const from = launch ?? { x: W * 0.15, y: H * 0.7 };
    start = { x: Math.min(W - r, Math.max(r, from.x)), y: Math.min(H - r, Math.max(r, from.y)) };
  }
  if (!dir) dir = { x: start.x < W / 2 ? 1 : -1, y: -1 }; // nothing to aim with: 45° towards the open side

  // --- Ground: the drawn line (AI role, else the lowest long horizontal ink band), else the photo's bottom ---
  let floorY = H;
  if (grounds.length) {
    const g = grounds.reduce((a, b) => (b.bbox.w > a.bbox.w ? b : a));
    floorY = g.bbox.h < g.bbox.w * 0.3 ? g.bbox.y + g.bbox.h / 2 : g.bbox.y;
  } else {
    const gy = groundLine(ink, W, H, start.y + r * 0.5);
    if (gy !== null) floorY = gy;
  }
  if (floorY < start.y + r) floorY = H;

  // Drawn ground length (a handwritten "5 m" under it sets the scale): the AI's ground stroke, else the ink on the line.
  let span: { x0: number; x1: number } | null = null;
  if (floorY < H) {
    const g = grounds.length ? grounds.reduce((a, b) => (b.bbox.w > a.bbox.w ? b : a)) : null;
    span = g && g.bbox.h < g.bbox.w * 0.3 ? { x0: g.bbox.x, x1: g.bbox.x + g.bbox.w } : groundSpan(ink, exclude, W, H, floorY);
  }
  const measures: Partial<Record<PartName, number>> = span ? { ground: span.x1 - span.x0 } : {};
  const scale = scaleFor(input, measures);

  const drop = floorY - (start.y + r);
  const angle = clampElevation(dir, drop > 3 * r ? MIN_ELEV_DROP_DEG : MIN_ELEV_GROUND_DEG);
  const unit = { x: Math.cos(angle), y: Math.sin(angle) };

  // --- Physics: the drawn scenery as static cells, a safety floor, and the ball ---
  if (ball) {
    // Leftover ink right around the ball (ring scraps, the root of the arrow, the muzzle lip) would be hit
    // on the first step. Only what is under the ball keeps colliding: that is what it rests on.
    const near = ball.r + 2 * CELL + 3;
    const c = ball.center;
    for (let y = Math.max(0, Math.floor(c.y - near)); y < Math.min(H, c.y + ball.r * 0.5); y++)
      for (let x = Math.max(0, Math.floor(c.x - near)); x <= Math.min(W - 1, Math.ceil(c.x + near)); x++)
        if ((x - c.x) ** 2 + (y - c.y) ** 2 <= near * near) exclude[y * W + x] = 1;
  }
  const scenery = sceneryBodies(ink, exclude, W, H);
  const floor = Matter.Bodies.rectangle(W / 2, floorY + 50, W * 4, 100, { isStatic: true, friction: 0.9 });
  const statics = [...scenery, floor];

  const bodyR = ball ? Math.max(5, r - ball.stroke * 0.5) : r;
  const body = Matter.Bodies.circle(start.x, start.y, bodyR, {
    friction: 0.9,
    frictionAir: 0,
    restitution: 0.15,
    density: 0.002,
  });
  const overlapping = () => {
    const near = Matter.Query.region(statics, body.bounds);
    return near.length > 0 && Matter.Query.collides(body, near).length > 0;
  };
  // Lift the ball off whatever it was drawn resting on, so the shot does not start inside the ground.
  let lifted = 0;
  for (let lift = 0; lift <= Math.ceil(r); lift++) {
    Matter.Body.setPosition(body, { x: start.x, y: start.y - lift });
    if (!overlapping()) {
      lifted = lift;
      start = { x: start.x, y: start.y - lift };
      break;
    }
  }
  Matter.Body.setPosition(body, start);
  // Still inside something (e.g. drawn inside the barrel): fly through until clear.
  const ghostAtStart = overlapping();
  const setGhost = (on: boolean) => {
    body.collisionFilter = { ...body.collisionFilter, mask: on ? 0 : 0xffffffff };
  };
  // Pass through the scenery until the ball has left its drawn spot: hand-drawn lines are bumpy, and a
  // ball resting on one would otherwise catch on the first bump (or the muzzle) and stop dead.
  setGhost(true);
  let ghost = true;

  // --- Launch speed: fitted so the arc lands inside the picture, unless params.speed (m/s) says otherwise ---
  const g = STEP_ACCEL * ((input.analysis.params.gravity || 9.8) / 9.8);
  const fall = Math.max(0, floorY - bodyR - start.y);
  const landX = (s: number) => {
    const vx = Math.abs(unit.x) * s, vUp = -unit.y * s;
    const t = (vUp + Math.sqrt(vUp * vUp + 2 * g * fall)) / g;
    return vx * t;
  };
  const space = (unit.x >= 0 ? W - start.x : start.x) - r;
  const range = Math.max(3 * r, space * 0.8);
  let lo = 0.5, hi = 80;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (landX(mid) < range) lo = mid;
    else hi = mid;
  }
  let speed = lo;
  const headroom = start.y - r - 4; // keep the apex on screen
  const vUp0 = -unit.y * speed;
  if (vUp0 > 0 && (vUp0 * vUp0) / (2 * g) > headroom)
    speed = Math.max(speed * 0.5, Math.sqrt(2 * g * Math.max(0, headroom)) / -unit.y);
  // A handwritten launch speed or the slider (params.speed, m/s) replaces the fitted one, converted to px per step.
  const fit = speed;
  const userSpeed = input.analysis.params.speed;
  const speedNote = noteFor(input.analysis, 'speed');
  let speedFrom: ValueSource = 'auto';
  if (typeof userSpeed === 'number' && userSpeed > 0) {
    speed = pxPerStep(userSpeed, scale);
    speedFrom = speedNote && Math.abs(speedNote.value - userSpeed) < 1e-6 ? 'note' : 'slider';
  }
  const v0 = { x: unit.x * speed, y: unit.y * speed };
  Matter.Body.setVelocity(body, v0);

  // --- Air resistance: F = −c·|v|·v on the ball (air.ts), times params.airDrag (factor on real air, 0 = off, read live) ---
  const kg = noteFor(input.analysis, 'mass', ['ball', 'block', 'bob'])?.value;
  const mass = kg ?? DEFAULT_KG;
  const cReal = dragConstant(bodyR / scale.pxPerMeter);
  // Factor that makes drag AIR_DRAG_TARGET × weight at the fitted launch speed on Earth: N·c·v² = target·m·g. The fit
  // comes from the drawing only (the slider and a written speed do not change it), so the factor stays the same when
  // the launch speed slider rebuilds the scene.
  const vRef = mps(fit, scale) * Math.sqrt(EARTH_G / Math.min(50, Math.max(0.5, input.analysis.params.gravity || EARTH_G)));
  const airFactor = roundFactor((AIR_DRAG_TARGET * mass * EARTH_G) / Math.max(1e-12, cReal * vRef * vRef));
  const params = input.analysis.params;
  // In engine units (px per step) the velocity change per step is −(c / m / pxPerMeter)·|v|·v, independent of the
  // slow-motion factor. Applied as the exact one-step solution v / (1 + β·|v|), which can never overshoot.
  const airDrag = () => {
    const beta = (Math.max(0, Number(params.airDrag) || 0) * cReal) / mass / scale.pxPerMeter;
    if (!beta) return;
    const v = body.velocity;
    const f = 1 / (1 + beta * Math.hypot(v.x, v.y));
    Matter.Body.setVelocity(body, { x: v.x * f, y: v.y * f });
  };
  if (DEBUG) {
    const deg = (p: Point) => Math.round((Math.atan2(-p.y, Math.abs(p.x)) * 1800) / Math.PI) / 10;
    console.log(
      `[projectile] arrow=${deg(dir)}° launch=${deg(v0)}° speed=${speed.toFixed(2)} ball=(${Math.round(start.x)},${Math.round(start.y)}) r=${r.toFixed(1)}`,
    );
  }

  // --- Loop: fly, land, wait 1.5 s, fire again. Keep the previous arc as a faint ghost. ---
  let trail: Point[] = [{ ...start }];
  let ghostTrail: Point[] = [];
  let steps = 0;
  let landedSteps = -1;
  let slowSteps = 0;
  const relaunchSteps = Math.round(RELAUNCH_MS / STEP_MS);
  const maxSteps = Math.round(MAX_FLIGHT_MS / STEP_MS);

  const touchingStatic = (engine: Matter.Engine) =>
    (engine.pairs?.list ?? []).some(
      (p: Matter.Pair) => p.isActive && (p.bodyA === body || p.bodyB === body) && (p.bodyA.isStatic || p.bodyB.isStatic),
    );

  const onStep = (engine: Matter.Engine) => {
    steps++;
    const p = body.position;
    if (DEBUG && (steps === 3 || steps === 8))
      console.log(
        `[projectile] step${steps} moved at ${(Math.atan2(-(p.y - start.y), Math.abs(p.x - start.x)) * 180 / Math.PI).toFixed(1)}°`,
      );
    if (ghost) {
      const away = Math.hypot(p.x - start.x, p.y - start.y) > 1.5 * r;
      if (away && (!ghostAtStart || !overlapping())) {
        ghost = false;
        setGhost(false);
      }
    }
    if (landedSteps < 0) {
      airDrag();
      if (steps % TRAIL_EVERY === 0) trail.push({ x: p.x, y: p.y });
      const moved = Math.hypot(p.x - start.x, p.y - start.y);
      slowSteps = Math.hypot(body.velocity.x, body.velocity.y) < 0.3 ? slowSteps + 1 : 0;
      const landed = !ghost && steps > 5 && moved > 3 * r && body.velocity.y > -0.5 && touchingStatic(engine);
      const stuck = steps > 20 && slowSteps > 30;
      const gone = p.x < -4 * r || p.x > W + 4 * r || p.y > H + 4 * r;
      if (landed || stuck || gone || steps > maxSteps) {
        trail.push({ x: p.x, y: p.y });
        landedSteps = 0;
      }
      return;
    }
    // Landed: roll to a stop instead of rolling off the picture.
    Matter.Body.setVelocity(body, { x: body.velocity.x * 0.93, y: body.velocity.y });
    Matter.Body.setAngularVelocity(body, body.angularVelocity * 0.93);
    if (++landedSteps < relaunchSteps) return;
    ghostTrail = trail;
    trail = [{ ...start }];
    steps = 0;
    slowSteps = 0;
    landedSteps = -1;
    Matter.Body.setPosition(body, start);
    Matter.Body.setAngle(body, 0);
    Matter.Body.setAngularVelocity(body, 0);
    Matter.Body.setVelocity(body, v0);
    ghost = true;
    setGhost(true);
  };

  const lw = Math.max(2, Math.min(W, H) / 220);
  const strokePath = (ctx: CanvasRenderingContext2D, pts: Point[]) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.stroke();
  };
  const onDraw = (ctx: CanvasRenderingContext2D) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.setLineDash([lw * 0.1, lw * 3]);
    ctx.strokeStyle = 'rgba(37,99,235,0.25)';
    strokePath(ctx, ghostTrail);
    ctx.strokeStyle = 'rgba(37,99,235,0.9)';
    strokePath(ctx, trail.concat(landedSteps < 0 ? [{ x: body.position.x, y: body.position.y }] : []));
  };

  let image: HTMLCanvasElement;
  let offset: Point;
  const masks: Uint8Array[] = [];
  if (ball) {
    ({ image, offset } = cutSprite(input, ball.mask));
    offset = { x: offset.x, y: offset.y - lifted }; // keep the sprite centred on the (lifted) body
    masks.push(ball.mask);
  } else {
    image = drawnBall(r);
    offset = { x: start.x - image.width / 2, y: start.y - image.height / 2 };
  }
  const sprite: Sprite = {
    image,
    offset,
    follow: { kind: 'body', body, origin: { ...start }, originAngle: 0 },
  };

  const launchAt = { ...start };
  const parts: Partial<Record<PartName, PartInfo>> = {
    arrow: { at: () => launchAt, clear: r * 1.5, side: 'above' },
    ball: { at: () => body.position, clear: r, body, kg: kg ?? DEFAULT_KG, kgFrom: kg ? 'note' : 'assumed' },
  };
  const ground = span;
  if (ground) parts.ground = { at: () => ({ x: (ground.x0 + ground.x1) / 2, y: floorY }), side: 'below' };

  return {
    bodies: [body, ...statics],
    constraints: [],
    sprites: [sprite],
    background: eraseFromPaper(input, masks),
    label: 'Projectile',
    onStep,
    onDraw,
    measures,
    parts,
    physics: { launchSpeed: { value: mps(speed, scale), fit: mps(fit, scale), from: speedFrom }, airDrag: airFactor },
    // The larger of the launch speed and the landing speed: v² = v₀² + 2g·(drop to the ground).
    speedHint: Math.sqrt(speed * speed + 2 * g * fall),
  };
};
