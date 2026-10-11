// Seesaw / lever drawings, from the ink alone: the triangle pivot, the plank lying on its tip and the weights on the
// plank. Pure (no DOM, no Matter), so the offline guess (guess.ts), the scene (lever.ts) and the node tests
// (tests/lever.test.ts) all use the same rules.
//
// Finding it:
//   1. Pivot = an enclosed paper region shaped like a triangle standing on its base: narrow at the top (≤ 40% of its
//      widest row), wide at the bottom, filling 30-72% of its box. (A ramp is such a triangle too: step 2 decides.)
//   2. Plank = the longest nearly level line (±20°) through the triangle's tip: lines through a point a little above
//      the tip are walked both ways along the ink (gaps of a few pen widths allowed). A lever's plank runs on both
//      sides of the tip and is at least twice as long as the triangle is wide; a ramp's slope (or a block on it) only
//      runs one way from its top corner, and is about as long as the triangle is wide.
//   3. The plank's thickness: the rows along the plank (in its own frame) where most of its length has ink, next to the
//      line found with small gaps (a plank drawn as a thin rectangle has two such lines).
//   4. Weights = the strokes above the plank that rest on it (their bottom near the plank's top), split left / right of
//      the tip. Mass ∝ drawn area (box of the stroke, down to the plank).
//
// Motion: one rigid body (plank + weights) turning about the tip. θ'' = τ / I with
//   τ = g Σ mᵢ xᵢ(θ)   (xᵢ = horizontal distance of weight i from the tip, right positive; θ clockwise on screen)
//   I = Σ mᵢ rᵢ² + I_plank
// The plank is light: its own weight is taken to act at the tip (a seesaw balances on its own), it only adds a little
// inertia. The plank end stops on the floor (the triangle's base), bounces a little and rests; then it replays.
// Balanced (Σ mᵢ uᵢ = 0, i.e. m₁d₁ = m₂d₂, every value typed in): it does not tip; a small rocking shows that it settles
// back level. Nearly balanced (moments within the drawing's error): it tips a little toward the heavier side and stays.

import type { BBox, Point } from '../types';

// ---- Tunables ----------------------------------------------------------------------------------------------------

/** Smallest pivot triangle side, fraction of the shorter image side. */
const TRI_MIN = 0.025;
/** Plank search: angles off level, degrees. */
export const PLANK_MAX_DEG = 20;
/** Strict (offline guess): plank at least this many triangle widths long, and this many on each side of the tip. */
const STRICT_LEN = 2;
const STRICT_SIDE = 0.5;
/** Relaxed (the AI or ?diagram=lever said it is a lever). */
const LOOSE_LEN = 1.3;
const LOOSE_SIDE = 0.1;
/** The plank's line has ink over at least this share of its length (strict / relaxed). */
const STRICT_COVER = 0.75;
const LOOSE_COVER = 0.5;
/**
 * Pivot triangle: row widths stay within this share of its widest row of a straight line (straight sides). 0.13, not
 * 0.1: a thick marker triangle under a slightly tilted plank (judge-lever-02) bulges ~12% near its tip.
 */
const STRAIGHT_SIDES = 0.13;
/** A plank row: this share of the plank's length has ink. */
const ROW_COVER = 0.45;
/** Plank inertia: the plank weighs this much of the weights together. */
export const PLANK_MASS_SHARE = 0.15;

// ---- Types -------------------------------------------------------------------------------------------------------

export interface LeverWeight {
  side: 'left' | 'right';
  /** Box in the plank frame: u along the plank from the tip (right positive), v across it (down positive, < 0 above). */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** Drawn area (px²), the mass share. */
  area: number;
  /** Ink pixels of the weight (indices into the image). */
  pixels: number[];
}

export interface LeverFind {
  /** Pen width, px. */
  stroke: number;
  /** Where the plank touches the tip: the turning point. */
  pivot: Point;
  /** The triangle as drawn: its tip and base corners (outer edge of the ink). */
  tip: Point;
  baseL: Point;
  baseR: Point;
  /** Plank direction as drawn, degrees (positive = right end lower). */
  deg: number;
  /** Plank ends along it from the pivot (uMin < 0 < uMax), px. */
  uMin: number;
  uMax: number;
  /** Plank band across it (v, down positive), px: drawn from vTop (its top edge) to vBot (≈ 0, its bottom). */
  vTop: number;
  vBot: number;
  /** Ink of the plank (indices). */
  plankPixels: number[];
  /** Share of the plank's length with ink on its line (a drawn plank is one unbroken line: ~1). */
  cover: number;
  /** One per side (several strokes on one side are joined). */
  left: LeverWeight | null;
  right: LeverWeight | null;
  why: string;
}

/** Plank frame → image. */
export function framePoint(f: Pick<LeverFind, 'pivot' | 'deg'>, u: number, v: number, deg = f.deg): Point {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: f.pivot.x + u * c - v * s, y: f.pivot.y + u * s + v * c };
}

// ---- Finding the lever -------------------------------------------------------------------------------------------

/**
 * The seesaw in the ink, or null. `strict` (offline guess): the plank must be long and run on both sides of the tip.
 * Relaxed: a shorter plank, mostly on one side, still counts (the AI already said it is a lever).
 */
export function findLever(ink: Uint8Array, W: number, H: number, strict = true): LeverFind | null {
  const minSide = Math.min(W, H);
  const stroke = penWidth(ink, W, H);
  const tris = triangles(ink, W, H, minSide).slice(0, 5);
  let best: LeverFind | null = null;
  let bestLen = 0;
  const notes: string[] = [];
  for (const t of tris) {
    const line = plankLine(ink, W, H, t, stroke, minSide);
    const triW = t.x1 - t.x0 + 1 + 2 * stroke;
    if (!line) {
      notes.push(`triangle@${Math.round(t.tipX)},${t.y0}: no level line on its tip`);
      continue;
    }
    const len = line.left + line.right;
    const [needLen, needSide] = strict ? [STRICT_LEN, STRICT_SIDE] : [LOOSE_LEN, LOOSE_SIDE];
    const ok = len >= needLen * triW && Math.min(line.left, line.right) >= needSide * triW;
    notes.push(
      `triangle@${Math.round(t.tipX)},${t.y0} w=${Math.round(triW)}: line ${line.deg}° ${Math.round(line.left)}+${Math.round(line.right)}px${ok ? '' : ' (too short / one-sided)'}`,
    );
    if (!ok || len <= bestLen) continue;
    const found = build(ink, W, H, t, line, stroke);
    if (!found) continue;
    notes.push(`cover ${found.cover.toFixed(2)}`);
    // A plank is drawn as one unbroken line; a row of zigzag teeth or scattered strokes only lines up in pieces.
    if (found.cover < (strict ? STRICT_COVER : LOOSE_COVER)) continue;
    best = found;
    bestLen = len;
  }
  if (best) best.why = notes.join('; ');
  return best;
}

interface Tri {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  tipX: number;
  /** Base corners of the paper region (inner edge). */
  botX0: number;
  botX1: number;
  area: number;
}

/** Enclosed paper regions shaped like a triangle standing on its base, biggest first. */
function triangles(ink: Uint8Array, W: number, H: number, minSide: number): Tri[] {
  const out: Tri[] = [];
  const minA = (TRI_MIN * minSide) ** 2;
  components(W, H, (i) => !ink[i], false, (pix, border) => {
    const n = pix.length;
    if (border || n < minA || n > W * H * 0.25) return;
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (const i of pix) {
      const x = i % W, y = (i - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const bh = y1 - y0 + 1, bw = x1 - x0 + 1;
    if (bh < TRI_MIN * minSide || bw < TRI_MIN * minSide) return;
    const fill = n / (bw * bh);
    if (fill < 0.3 || fill > 0.72) return;
    const rx0 = new Int32Array(bh).fill(W), rx1 = new Int32Array(bh).fill(-1), sumX = new Float64Array(bh), cnt = new Int32Array(bh);
    for (const i of pix) {
      const x = i % W, r = (i - x) / W - y0;
      if (x < rx0[r]) rx0[r] = x;
      if (x > rx1[r]) rx1[r] = x;
      sumX[r] += x;
      cnt[r]++;
    }
    const width = (r: number) => (rx1[r] < 0 ? 0 : rx1[r] - rx0[r] + 1);
    let maxW = 0;
    for (let r = 0; r < bh; r++) maxW = Math.max(maxW, width(r));
    const top = Math.max(1, Math.round(bh * 0.12));
    let topW = 0;
    for (let r = 0; r < top; r++) topW += width(r);
    topW /= top;
    let botW = 0;
    for (let r = Math.floor(bh * 0.75); r < bh; r++) botW = Math.max(botW, width(r));
    if (topW > 0.4 * maxW || botW < 0.75 * maxW) return;
    // A pivot stands up (not a flat sliver), and its sides are straight: the row width grows in a straight line from
    // the tip to the base. A wheel's inside, a ring or a cannon's mouth grows like a circle (fast, then levelling off).
    if (bh < 0.35 * bw) return;
    const r0 = Math.floor(bh * 0.1), r1 = Math.ceil(bh * 0.9);
    let n0 = 0, sr = 0, sw = 0, srr = 0, srw = 0;
    for (let r = r0; r < r1; r++) {
      const w = width(r);
      n0++;
      sr += r;
      sw += w;
      srr += r * r;
      srw += r * w;
    }
    const den = n0 * srr - sr * sr;
    if (n0 < 4 || den <= 0) return;
    const k = (n0 * srw - sr * sw) / den, b0 = (sw - k * sr) / n0;
    let worst = 0;
    for (let r = r0; r < r1; r++) worst = Math.max(worst, Math.abs(width(r) - (k * r + b0)));
    if (worst > STRAIGHT_SIDES * maxW) return;
    let sx = 0, sc = 0;
    for (let r = 0; r < Math.min(bh, 3); r++) {
      sx += sumX[r];
      sc += cnt[r];
    }
    // Base corners: the widest of the bottom rows.
    let bx0 = W, bx1 = -1;
    for (let r = Math.max(0, bh - 3); r < bh; r++) {
      if (rx1[r] < 0) continue;
      bx0 = Math.min(bx0, rx0[r]);
      bx1 = Math.max(bx1, rx1[r]);
    }
    out.push({ x0, x1, y0, y1, tipX: sx / Math.max(1, sc), botX0: bx0, botX1: bx1, area: n });
  });
  return out.sort((a, b) => b.area - a.area);
}

interface Line {
  /** Degrees from level. */
  deg: number;
  /** A point on the line above the tip. */
  at: Point;
  /** Ink run along the line to the left / right of the tip, px. */
  left: number;
  right: number;
}

/** The longest nearly level ink line through (a little above) the triangle's tip. */
function plankLine(ink: Uint8Array, W: number, H: number, t: Tri, stroke: number, minSide: number): Line | null {
  const r = Math.max(1, Math.round(stroke * 0.5));
  const gapMax = Math.max(3 * stroke, 0.015 * minSide);
  const reach = Math.round(4 * stroke + 0.03 * minSide);
  const inkAt = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < W && yi < H && ink[yi * W + xi] !== 0;
  };
  let best: Line | null = null;
  for (let deg = -PLANK_MAX_DEG; deg <= PLANK_MAX_DEG; deg++) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    // Normal (pointing down for a level line).
    const nx = -s, ny = c;
    for (let dy = -reach; dy <= Math.round(stroke); dy++) {
      const at = { x: t.tipX, y: t.y0 + dy };
      const hit = (k: number) => {
        const x = at.x + c * k, y = at.y + s * k;
        for (let d = -r; d <= r; d++) if (inkAt(x + nx * d, y + ny * d)) return true;
        return false;
      };
      const walk = (dir: 1 | -1) => {
        let last = -1, gap = 0;
        for (let k = 0; ; k++) {
          const x = at.x + c * k * dir, y = at.y + s * k * dir;
          if (x < 0 || y < 0 || x >= W || y >= H) break;
          if (hit(k * dir)) {
            last = k;
            gap = 0;
          } else if (++gap > gapMax) break;
        }
        return last;
      };
      const right = walk(1), left = walk(-1);
      if (right < 0 || left < 0) continue;
      const len = left + right;
      if (!best || len > best.left + best.right + 0.5 || (len > best.left + best.right - 0.5 && Math.abs(deg) < Math.abs(best.deg)))
        best = { deg, at, left, right };
    }
  }
  return best;
}

/** Thickness, pivot point and weights of the lever whose plank runs along `line`. */
function build(ink: Uint8Array, W: number, H: number, t: Tri, line0: Line, stroke: number): LeverFind | null {
  const len = line0.left + line0.right;
  const step = Math.max(1, Math.round(len / 300));
  const coverOf = (deg: number, O: Point, v: number) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let n = 0, hit = 0;
    for (let u = -line0.left; u <= line0.right; u += step) {
      n++;
      const x = Math.round(O.x + u * c - v * s), y = Math.round(O.y + u * s + v * c);
      if (x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x]) hit++;
    }
    return hit / Math.max(1, n);
  };
  // The search went in whole degrees: settle the angle to 0.1° on the row with the most ink (a long line drawn 0.5°
  // off would otherwise wander across a few rows and look thin).
  let line = line0, bestCover = -1;
  const r0 = Math.max(1, Math.round(stroke));
  for (let d = -1; d <= 1.0001; d += 0.1)
    for (let dv = -r0; dv <= r0; dv++) {
      const deg = Math.round((line0.deg + d) * 10) / 10;
      if (Math.abs(deg) > PLANK_MAX_DEG) continue;
      const a = (deg * Math.PI) / 180;
      const O = { x: line0.at.x - dv * Math.sin(a), y: line0.at.y + dv * Math.cos(a) };
      const cv = coverOf(deg, O, 0);
      if (cv > bestCover + 1e-9) {
        bestCover = cv;
        line = { ...line0, deg, at: O };
      }
    }
  const a = (line.deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const O = line.at;
  const at = (u: number, v: number) => {
    const x = Math.round(O.x + u * c - v * s), y = Math.round(O.y + u * s + v * c);
    return x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1;
  };
  // Rows along the plank where most of its length has ink.
  const maxThick = Math.max(3 * stroke, 0.12 * len);
  const cover = (v: number) => coverOf(line.deg, O, v);
  const gap = Math.max(2 * stroke, 0.06 * len);
  let vTop = 0, vBot = 0;
  for (let v = 0, miss = 0; v >= -maxThick && miss <= gap; v--) {
    if (cover(v) >= ROW_COVER) {
      vTop = v;
      miss = 0;
    } else miss++;
  }
  for (let v = 0, miss = 0; v <= maxThick && miss <= gap; v++) {
    if (cover(v) >= ROW_COVER) {
      vBot = v;
      miss = 0;
    } else miss++;
  }
  if (vBot - vTop > 0.2 * len) return null;
  // Re-centre the frame on the pivot: the plank's bottom edge above the tip.
  const pivot = { x: O.x - (vBot + 0.5) * s, y: O.y + (vBot + 0.5) * c };
  const shift = vBot + 0.5;
  const top = vTop - shift, bot = 0;
  // In the new frame: u unchanged (O is above the tip), v' = v - shift.
  const atP = (u: number, v: number) => at(u, v + shift);
  const uMin = -line.left, uMax = line.right;

  // Plank ink: the band (plus half a pen either side) along its length.
  const plankPixels: number[] = [];
  const seen = new Uint8Array(W * H);
  const pad = Math.ceil(stroke * 0.6);
  for (let v = Math.floor(top - pad); v <= bot + pad; v++)
    for (let u = Math.floor(uMin - pad); u <= Math.ceil(uMax + pad); u++) {
      const i = atP(u, v);
      if (i >= 0 && ink[i] && !seen[i]) {
        seen[i] = 1;
        plankPixels.push(i);
      }
    }

  // Weights: ink above the plank, near its length, in pieces that rest on it.
  const above = new Uint8Array(W * H);
  const uPad = 0.05 * len;
  const lift = top - Math.max(1, stroke * 0.6);
  const cosA = c, sinA = s;
  const toFrame = (x: number, y: number) => {
    const dx = x - pivot.x, dy = y - pivot.y;
    return { u: dx * cosA + dy * sinA, v: -dx * sinA + dy * cosA };
  };
  // Scan the image box that holds the region above the plank.
  const corners = [framePoint({ pivot, deg: line.deg }, uMin - uPad, lift), framePoint({ pivot, deg: line.deg }, uMax + uPad, lift),
    framePoint({ pivot, deg: line.deg }, uMin - uPad, lift - 0.8 * len), framePoint({ pivot, deg: line.deg }, uMax + uPad, lift - 0.8 * len)];
  const bx0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x)))), bx1 = Math.min(W - 1, Math.ceil(Math.max(...corners.map((p) => p.x))));
  const by0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y)))), by1 = Math.min(H - 1, Math.ceil(Math.max(...corners.map((p) => p.y))));
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      const i = y * W + x;
      if (!ink[i] || seen[i]) continue;
      const f = toFrame(x, y);
      if (f.v < lift && f.v > lift - 0.8 * len && f.u >= uMin - uPad && f.u <= uMax + uPad) above[i] = 1;
    }
  interface Piece { pixels: number[]; u0: number; u1: number; v0: number; v1: number; su: number }
  const pieces: Piece[] = [];
  components(W, H, (i) => above[i] === 1, true, (pix) => {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, su = 0;
    for (const i of pix) {
      const x = i % W, y = (i - x) / W;
      const f = toFrame(x, y);
      u0 = Math.min(u0, f.u);
      u1 = Math.max(u1, f.u);
      v0 = Math.min(v0, f.v);
      v1 = Math.max(v1, f.v);
      su += f.u;
    }
    pieces.push({ pixels: Array.from(pix), u0, u1, v0, v1, su: su / pix.length });
  });
  const biggest = Math.max(0, ...pieces.map((p) => p.pixels.length));
  const rest = Math.max(4 * stroke, 0.05 * len);
  const kept = pieces.filter(
    (p) =>
      p.pixels.length >= Math.max(20, 0.1 * biggest) &&
      Math.max(p.u1 - p.u0, p.v1 - p.v0) >= 2 * stroke &&
      // Resting on the plank (not floating far above it), and not a sliver along the plank's edge.
      p.v1 >= top - rest &&
      !(p.v1 - p.v0 < 2 * stroke && p.u1 - p.u0 > 0.3 * len),
  );
  const side = (which: 'left' | 'right'): LeverWeight | null => {
    const ps = kept.filter((p) => (which === 'left' ? p.su < 0 : p.su >= 0));
    if (!ps.length) return null;
    let area = 0, u0 = Infinity, u1 = -Infinity, v0 = Infinity;
    const pixels: number[] = [];
    for (const p of ps) {
      area += (p.u1 - p.u0 + 1) * (top - p.v0);
      u0 = Math.min(u0, p.u0);
      u1 = Math.max(u1, p.u1);
      v0 = Math.min(v0, p.v0);
      pixels.push(...p.pixels);
    }
    return { side: which, u0, u1, v0, v1: top, area, pixels };
  };
  // Triangle corners as drawn (outer edge of the ink).
  const half = stroke / 2;
  return {
    stroke,
    pivot,
    tip: { x: t.tipX, y: t.y0 - stroke },
    baseL: { x: t.botX0 - stroke, y: t.y1 + half },
    baseR: { x: t.botX1 + stroke, y: t.y1 + half },
    deg: line.deg,
    uMin,
    uMax,
    vTop: top,
    vBot: bot,
    plankPixels,
    cover: bestCover,
    left: side('left'),
    right: side('right'),
    why: '',
  };
}

/** Typical pen width: median over ink pixels of min(horizontal run, vertical run). */
function penWidth(ink: Uint8Array, W: number, H: number): number {
  const hRun = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!ink[y * W + x]) {
        x++;
        continue;
      }
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
      if (!ink[y * W + x]) {
        y++;
        continue;
      }
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

/** Connected pieces of the pixels where `on(i)` (4- or 8-connected); `visit` gets each piece and whether it touches the border. */
function components(W: number, H: number, on: (i: number) => boolean, eight: boolean, visit: (pix: Int32Array, border: boolean) => void) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !on(s)) continue;
    let top = 0, border = false;
    stack[top++] = s;
    seen[s] = 1;
    const pix: number[] = [];
    while (top) {
      const i = stack[--top];
      pix.push(i);
      const x = i % W, y = (i - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!eight && dx && dy)) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (!seen[j] && on(j)) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
    }
    visit(Int32Array.from(pix), border);
  }
}

// ---- Motion ------------------------------------------------------------------------------------------------------

/** A weight as the motion sees it: mass (kg, any scale) and its centre in the plank frame (px, v < 0 above). */
export interface LeverItem {
  m: number;
  u: number;
  v: number;
}

export interface LeverModel {
  items: LeverItem[];
  /** Plank inertia about the pivot (same units as Σ m r²). */
  plankI: number;
  /** Where the plank's ends meet the floor: the most the plank turns each way (radians, min < 0 < max). */
  thetaMin: number;
  thetaMax: number;
}

/** Plank inertia: a uniform rod from uMin to uMax (px) about the pivot, of mass `m`. */
export const rodInertia = (m: number, uMin: number, uMax: number) =>
  uMax - uMin > 0 ? (m * (uMax ** 3 - uMin ** 3)) / (3 * (uMax - uMin)) : 0;

/** Turning limits: the left end (at uMin) or the right end (at uMax) of the plank's bottom edge reaches `depth` below the pivot. */
export function floorLimits(uMin: number, uMax: number, depth: number): { thetaMin: number; thetaMax: number } {
  const lim = (arm: number) => (arm > depth ? Math.asin(depth / arm) : (60 * Math.PI) / 180);
  return { thetaMin: -lim(-uMin), thetaMax: lim(uMax) };
}

/** Torque of gravity about the pivot at angle θ (radians, clockwise on screen), `g` in px/step²: g Σ mᵢ xᵢ(θ). */
export function leverTorque(m: LeverModel, theta: number, g: number): number {
  const c = Math.cos(theta), s = Math.sin(theta);
  let t = 0;
  for (const it of m.items) t += it.m * (it.u * c - it.v * s);
  return g * t;
}

export function leverInertia(m: LeverModel): number {
  let I = m.plankI;
  for (const it of m.items) I += it.m * (it.u * it.u + it.v * it.v);
  return I;
}

/** Σ mᵢ uᵢ against Σ mᵢ |uᵢ|: how far from balanced (0 = m₁d₁ = m₂d₂), -1..1, positive = right side heavier. */
export function imbalance(m: LeverModel): number {
  let net = 0, abs = 0;
  for (const it of m.items) {
    net += it.m * it.u;
    abs += it.m * Math.abs(it.u);
  }
  return abs > 0 ? net / abs : 0;
}

/** Drawn sizes are rough: moments this close (share of the larger, |imbalance|) only count as nearly balanced. */
export const DRAWN_BALANCE = 0.12;
/** Every value typed in: the moments must match to this. */
export const INPUT_BALANCE = 1e-3;
/** Nearly balanced: the plank settles this much toward the heavier side per unit of imbalance, at most NEARLY_MAX. */
const NEARLY_PER = (25 * Math.PI) / 180;
const NEARLY_MAX = (3 * Math.PI) / 180;

export interface Balance {
  /** It does not tip to the floor (rocks gently instead). */
  balanced: boolean;
  /** Balanced only within the drawing's error (some value is estimated from the drawn size): "Nearly balanced". */
  nearly: boolean;
  /** Where it settles, radians from the start (toward the heavier side, positive = right end down). */
  settle: number;
}

/**
 * The verdict for imbalance `tilt` (see imbalance()). `exact`: every mass and distance was typed in, so only
 * m₁d₁ = m₂d₂ is balanced. Otherwise moments within DRAWN_BALANCE are "nearly balanced": it tips a little toward the
 * heavier side (in proportion to the difference) and stops there, instead of slamming down or claiming a tie.
 */
export function balanceOf(tilt: number, exact: boolean, twoSides = true): Balance {
  if (!twoSides) return { balanced: false, nearly: false, settle: 0 };
  if (exact) return { balanced: Math.abs(tilt) <= INPUT_BALANCE, nearly: false, settle: 0 };
  if (Math.abs(tilt) > DRAWN_BALANCE) return { balanced: false, nearly: false, settle: 0 };
  return { balanced: true, nearly: true, settle: Math.sign(tilt) * Math.min(NEARLY_MAX, Math.abs(tilt) * NEARLY_PER) };
}

/**
 * A point fixed in the plank frame at (u, v) from the pivot `P`, with the plank at angle θ turning at ω (per step):
 * where it is and how fast it moves (d/dt of the pose). Weights ride on the plank this way: never on their own.
 */
export function riding(P: Point, u: number, v: number, theta: number, omega: number): { at: Point; vel: Point } {
  const c = Math.cos(theta), s = Math.sin(theta);
  return {
    at: { x: P.x + u * c - v * s, y: P.y + u * s + v * c },
    vel: { x: -omega * (u * s + v * c), y: omega * (u * c - v * s) },
  };
}

/** Restitution when the plank end hits the floor. */
const BOUNCE = 0.3;
/** Slower than this after a bounce (rad/step): it rests. */
const REST_OMEGA = 0.0015;
/** Steps resting on the floor before replaying (1.5 s). */
export const HOLD_STEPS = 90;
/** Balanced rocking: amplitude (rad), period and decay (steps), one cycle (steps). */
const ROCK_AMP = (2.5 * Math.PI) / 180;
const ROCK_PERIOD = 70;
const ROCK_DECAY = 80;
const ROCK_CYCLE = 300;

/**
 * The plank's angle, step by step (semi-implicit Euler: ω += τ/I, θ += ω). `balanced`: no tipping; a gentle rocking
 * about level that dies away and starts again, so the scene never looks frozen.
 */
export class LeverMotion {
  theta: number;
  omega = 0;
  /** Steps resting on the floor (counts up to HOLD_STEPS, then replays). */
  hold = 0;
  bounces = 0;
  private t = 0;
  readonly model: LeverModel;
  readonly theta0: number;
  readonly balanced: boolean;
  /** Nearly balanced: it settles this far (radians) from theta0 toward the heavier side, and rocks about there. */
  readonly settle: number;
  constructor(model: LeverModel, theta0: number, balanced: boolean, settle = 0) {
    this.model = model;
    this.theta0 = theta0;
    this.balanced = balanced;
    // Never as far as the floor: a gentle tilt, well inside the turning range.
    const room = settle > 0 ? model.thetaMax - theta0 : theta0 - model.thetaMin;
    this.settle = balanced ? Math.sign(settle) * Math.min(Math.abs(settle), 0.5 * Math.max(0, room)) : 0;
    this.theta = theta0;
  }

  reset() {
    this.theta = this.theta0;
    this.omega = 0;
    this.hold = 0;
    this.bounces = 0;
    this.t = 0;
  }

  /** Angular acceleration now, rad/step², for gravity `g` px/step². */
  accel(g: number): number {
    return leverTorque(this.model, this.theta, g) / leverInertia(this.model);
  }

  step(g: number) {
    if (this.balanced) {
      const t = this.t++;
      const k = t % ROCK_CYCLE;
      const rock = (s: number) => ROCK_AMP * Math.sin((2 * Math.PI * s) / ROCK_PERIOD) * Math.exp(-s / ROCK_DECAY);
      // Nearly balanced: the first cycle is a damped swing from theta0 over to the tilted rest (no jump at the start);
      // after it, the same gentle rocking as balanced, about that rest.
      const next =
        this.settle === 0
          ? this.theta0 + rock(k)
          : t < ROCK_CYCLE
            ? this.theta0 + this.settle * (1 - Math.exp(-t / ROCK_DECAY) * Math.cos((2 * Math.PI * t) / ROCK_PERIOD))
            : this.theta0 + this.settle + 0.5 * rock(k);
      this.omega = next - this.theta;
      this.theta = next;
      return;
    }
    if (this.hold > 0) {
      if (++this.hold > HOLD_STEPS) this.reset();
      return;
    }
    this.omega += this.accel(g);
    this.theta += this.omega;
    const { thetaMin, thetaMax } = this.model;
    const hit = this.theta >= thetaMax ? thetaMax : this.theta <= thetaMin ? thetaMin : null;
    if (hit === null) return;
    this.theta = hit;
    this.omega = -BOUNCE * this.omega;
    this.bounces++;
    if (Math.abs(this.omega) < REST_OMEGA || this.bounces >= 4) {
      this.omega = 0;
      this.hold = 1;
    }
  }
}

/** Box helper for callers: a weight's box in the plank frame as an image-space BBox at angle `deg` (axis-aligned bounds). */
export function weightBounds(f: Pick<LeverFind, 'pivot' | 'deg'>, w: LeverWeight): BBox {
  const pts = [framePoint(f, w.u0, w.v0), framePoint(f, w.u1, w.v0), framePoint(f, w.u0, w.v1), framePoint(f, w.u1, w.v1)];
  const x0 = Math.min(...pts.map((p) => p.x)), y0 = Math.min(...pts.map((p) => p.y));
  return { x: x0, y: y0, w: Math.max(...pts.map((p) => p.x)) - x0, h: Math.max(...pts.map((p) => p.y)) - y0 };
}
