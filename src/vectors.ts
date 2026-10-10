// Velocity arrows: one arrow per moving body of the drawing, from its centre in the direction it moves.
// Length is strictly proportional to speed with one factor for the whole scene, so arrows can be compared.
// The factor is picked per drawing from the top speed the scene expects (its speedHint, from its own physics),
// or the fastest motion seen if that is faster: the top speed gets an arrow about a fifth of the picture, so
// from the very first run an arrow grows as the body speeds up. A scale bar in the corner says how long
// "1 m/s" (or 0.2 m/s, ...) is.

import Matter from 'matter-js';
import { STEP_ACCEL, STEP_MS, type Simulation } from './sim';
import type { BuiltScene } from './types';
import { mps, scaleOf } from './units';

const STEP_S = STEP_MS / 1000;
/** Fixed screen conversion used only for the smoothing thresholds (a visual matter, independent of the drawing's scale). */
const PX_PER_M = STEP_ACCEL / (STEP_S * STEP_S) / 9.8;

/** The scene's top speed gets an arrow this long (fraction of the picture's short side). */
export const LMAX_FRACTION = 0.22;
/**
 * The factor is Lmax / vRef, where vRef is the larger of the scene's expected top speed (BuiltScene.speedHint)
 * and the fastest speed seen so far (it only ever grows, so every arrow stays comparable with every earlier
 * one). A scene without a hint gets a small provisional value for the first second instead, so its very first
 * frames are not scaled against a near-zero maximum, and a floor keeps a scene that hardly moves from blowing
 * its arrows up.
 */
const SEED_MPS = 0.3;
const SEED_FRAMES = 60;
const MIN_VREF_MPS = 0.1;
/** Factor changes are eased (settles in ~0.3 s). Within one frame every arrow still shares the same factor. */
const EASE = 1 - Math.exp(-STEP_S / 0.1);

/**
 * Visibility: the threshold is this share of the top speed (at least SHOW_MIN_MPS). An arrow appears at
 * SHOW_HYST times the threshold and goes away after HIDE_FRAMES frames below it, so jitter never flickers.
 */
const SHOW_FRACTION = 0.04;
const SHOW_MIN_MPS = 0.05;
const SHOW_HYST = 1.5;
const HIDE_FRAMES = 10;
/**
 * A sudden stop (a block hitting the floor or a wall, a pulley weight reaching the end) is followed by a small
 * settling wobble that reads as flicker. A body that stopped like that keeps its arrow hidden until a clear
 * restart: this share of the top speed, or moving this fraction of its own size away from where it stopped.
 * A gentle slowdown (a swing's turning point, a rolling ball) is not a stop and gets its arrow back at once.
 */
const CRASH_FROM = 0.3;
const CRASH_TO = 0.1;
const WAKE_FRACTION = 0.2;
const WAKE_TRAVEL = 0.5;
/**
 * Light smoothing of the velocity vector (weight of the newest frame), only while slow: that is where
 * contact jitter would make a tiny arrow twitch. Above SMOOTH_BELOW_MPS the arrow is the exact velocity.
 */
const SMOOTH = 0.5;
const SMOOTH_BELOW_MPS = 0.5;
/** A jump larger than this (world px in one frame) is a reset/relaunch: drop the smoothing history. */
const JUMP_PX = 60;

const COLOR = '#ff4b4b';
const INK = '#3c3c3c';
const FONT = 'Nunito, "Avenir Next", system-ui, sans-serif';
/** Sizes in CSS px, converted to world px each frame so they look the same on any screen. */
const SHAFT_CSS = 4;
const OUTLINE_CSS = 2.5;
const HEAD_LEN_CSS = 13;
const HEAD_HALF_W_CSS = 8;
const LABEL_CSS = 12;
const LABEL_GAP_CSS = 8;
const EDGE_PAD_CSS = 4;
const BAR_MARGIN_CSS = 10;
/** Room a label keeps from another label and from the scale bar (CSS px). */
export const LABEL_SPACE_CSS = 6;
/** Half the width an arrow takes on screen, white outline included (CSS px): along the shaft, and at the head. */
export const ARROW_HALF_CSS = SHAFT_CSS / 2 + OUTLINE_CSS;
export const ARROW_HEAD_HALF_CSS = HEAD_HALF_W_CSS + OUTLINE_CSS;
/** Room the speed label of an arrow may take past its tip (CSS px): about "10.0 m/s" plus its gap. */
export const ARROW_LABEL_REACH_CSS = 70;

interface Track {
  vx: number; // px/step, smoothed
  vy: number;
  x: number;
  y: number;
  /** Smoothed speed this frame, m/s. */
  speed: number;
  shown: boolean;
  /** Consecutive frames under the hide threshold. */
  below: number;
  /** Set by a sudden stop: where it stopped and how big it is (see WAKE_*). */
  rest: { x: number; y: number; size: number } | null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Things a label should not cover: a moving body's box, or a rope / spring drawn as a line. `hard` ones
 * (the scale bar's pill) would hide the label; the rest only look untidy, so they can be overlapped in need.
 */
type Obstacle = ({ box: Box } | { seg: [number, number, number, number] }) & { hard?: boolean };

/** One drawn arrow (exposed for tests). Lengths in world px, speed in m/s. */
export interface ArrowSample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  /** Nominal length (= speed × k). */
  length: number;
  /** World px per m/s; the same for every arrow of the frame. */
  k: number;
  /** Length actually drawn: shorter than `length` only when the arrow was stopped at the picture's edge. */
  drawn: number;
  clipped: boolean;
  tip: { x: number; y: number };
  /** Where the speed label went. */
  label: Box;
}

/** The scale in use (exposed for tests). */
export interface ArrowScale {
  /** World px per m/s. */
  k: number;
  /** Top speed the factor is based on, m/s. */
  vRef: number;
  /** The scene's expected top speed (speedHint), m/s; 0 when the scene gives none. */
  hint: number;
  /** Scale bar in the corner: a round number of m/s and its length in world px (= k × mps). */
  bar: { mps: number; px: number };
  /** The scale bar's pill, world px. */
  box: Box;
}

export class VelocityArrows {
  enabled = true;
  private tracks = new Map<Matter.Body, Track>();
  private sim: Simulation | null = null;
  private input: HTMLInputElement | null = null;
  /** Fastest smoothed speed seen in this scene, m/s. */
  private vMax = 0;
  /** The scene's expected top speed (speedHint), m/s; 0 = none. */
  private hint = 0;
  private frames = 0;
  /** Eased factor, world px per m/s (0 = not set yet). */
  private kShown = 0;
  /** Arrows drawn in the last frame. */
  last: ArrowSample[] = [];
  /** Scale used in the last frame (null while nothing is drawn). */
  scale: ArrowScale | null = null;
  /** Boxes (world px, this frame) the speed labels should stay off when they can, e.g. the value labels. */
  avoid: () => Box[] = () => [];

  /** New photo: stop drawing the old drawing's arrows until the next attach(). */
  reset() {
    this.sim = null;
    this.last = [];
    this.scale = null;
  }

  /** Hook into a freshly started simulation. */
  attach(sim: Simulation) {
    this.sim = sim;
    this.tracks.clear();
    this.last = [];
    this.scale = null;
    this.vMax = 0;
    const hint = sim.scene.speedHint;
    this.hint = hint && hint > 0 && Number.isFinite(hint) ? mps(hint, scaleOf(sim.scene)) : 0;
    this.frames = 0;
    this.kShown = 0;
    sim.drawListeners.push((ctx, scene, s) => {
      if (this.sim === sim) this.draw(ctx, scene, s);
    });
  }

  /** Adds the "Velocity arrows" switch to a panel (after its sliders if it has any). */
  mountToggle(panel: HTMLElement) {
    injectStyle();
    const row = document.createElement('label');
    row.className = 'va-toggle';
    row.innerHTML = `
      <span class="va-text">Velocity arrows<span class="va-sub">Arrow length shows speed</span></span>
      <input type="checkbox" checked />
      <span class="va-switch"></span>`;
    const input = row.querySelector('input')!;
    input.checked = this.enabled;
    input.addEventListener('change', () => {
      navigator.vibrate?.(10);
      this.enabled = input.checked;
      if (!this.enabled) {
        this.last = [];
        this.scale = null;
      }
    });
    this.input = input;
    const sliders = panel.querySelector('.sliders');
    if (sliders) sliders.after(row);
    else panel.appendChild(row);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.input) this.input.checked = on;
  }

  /** Bodies the user sees moving: the ones a sprite of the drawing follows, never static ones. */
  private movingBodies(scene: BuiltScene): Matter.Body[] {
    const out: Matter.Body[] = [];
    for (const sp of scene.sprites) {
      const f = sp.follow;
      if (f.kind === 'stretch') continue;
      if (f.body.isStatic || out.includes(f.body)) continue;
      out.push(f.body);
    }
    return out;
  }

  private draw(ctx: CanvasRenderingContext2D, scene: BuiltScene, pxScale: number) {
    const bodies = this.movingBodies(scene);
    const scale = scaleOf(scene);
    // World px per CSS px.
    const css = (window.devicePixelRatio || 1) / pxScale;
    const worldW = ctx.canvas.width / ctx.getTransform().a;
    const worldH = ctx.canvas.height / ctx.getTransform().d;
    const lmax = LMAX_FRACTION * Math.min(worldW, worldH);

    // Pass 1: smoothed velocity and speed of every body, and the top speed of the scene so far.
    let maxNow = 0;
    for (const b of bodies) {
      const p = b.position;
      let t = this.tracks.get(b);
      if (!t || Math.hypot(p.x - t.x, p.y - t.y) > JUMP_PX) {
        t = { vx: b.velocity.x, vy: b.velocity.y, x: p.x, y: p.y, speed: 0, shown: false, below: 0, rest: null };
        this.tracks.set(b, t);
      } else {
        // Smooth only when it was slow and still is, so a sudden stop (landing, end of the ramp) is exact too.
        const raw = Math.hypot(b.velocity.x, b.velocity.y) / STEP_S / PX_PER_M;
        const prev = Math.hypot(t.vx, t.vy) / STEP_S / PX_PER_M;
        // A reversal (turning point of a swing or spring) is shown at once, never averaged towards zero.
        const sameWay = b.velocity.x * t.vx + b.velocity.y * t.vy > 0;
        const k = sameWay && Math.max(raw, prev) < SMOOTH_BELOW_MPS ? SMOOTH : 1;
        t.vx += (b.velocity.x - t.vx) * k;
        t.vy += (b.velocity.y - t.vy) * k;
        t.x = p.x;
        t.y = p.y;
      }
      const speed = mps(Math.hypot(t.vx, t.vy), scale); // physical m/s (units.ts)
      this.updateShown(t, b, speed);
      t.speed = speed;
      maxNow = Math.max(maxNow, speed);
    }

    // The factor for this frame: Lmax at the expected top speed, or at the fastest seen if that is faster.
    this.vMax = Math.max(this.vMax, maxNow);
    const vRef = this.vRef();
    this.frames++;
    const kTarget = lmax / vRef;
    let k = this.kShown > 0 ? this.kShown + (kTarget - this.kShown) * EASE : kTarget;
    // While easing, never let the fastest arrow run past Lmax.
    if (maxNow > 0) k = Math.min(k, lmax / maxNow);
    this.kShown = k;

    if (!this.enabled) {
      this.last = [];
      this.scale = null;
      return;
    }

    // Pass 2: arrows first, then every label on top, then the scale bar (labels keep clear of its pill).
    const samples: ArrowSample[] = [];
    ctx.font = `800 ${LABEL_CSS * css}px ${FONT}`;
    const bar = layoutScaleBar(ctx, css, worldH, k, vRef);
    const obstacles = this.obstacles(scene, bodies, css);
    // The scale bar and the value labels are text a speed label must never cover, and it keeps a little room from them.
    const space = LABEL_SPACE_CSS * css;
    obstacles.push({ box: grow(bar.box, space), hard: true });
    for (const box of this.avoid()) obstacles.push({ box: grow(box, space), hard: true });
    const labels: Array<{ text: string; box: Box }> = [];
    const edge = (HEAD_HALF_W_CSS + OUTLINE_CSS) * css;
    for (const b of bodies) {
      const t = this.tracks.get(b)!;
      if (!t.shown) continue;
      const p = b.position;
      const n = Math.hypot(t.vx, t.vy);
      if (!(n > 0)) continue;
      const ux = t.vx / n, uy = t.vy / n;
      const speed = t.speed;
      const length = speed * k;
      // Stop the shaft at the picture's edge; the head is then drawn right at the edge.
      const reach = reachToEdge(p.x, p.y, ux, uy, worldW, worldH, edge);
      if (!(reach > 0)) continue; // the body itself is off the picture
      const drawn = Math.min(length, reach);
      const tip = { x: p.x + ux * drawn, y: p.y + uy * drawn };
      const headLen = drawArrow(ctx, p.x, p.y, ux, uy, drawn, css);
      const text = `${speed.toFixed(1)} m/s`;
      const tw = ctx.measureText(text).width;
      const bb = b.bounds;
      const site: LabelSite = { tip, ux, uy, headLen, origin: { x: p.x, y: p.y }, body: { x: bb.min.x, y: bb.min.y, w: bb.max.x - bb.min.x, h: bb.max.y - bb.min.y } };
      const label = placeLabel(site, tw + 6 * css, (LABEL_CSS + 4) * css, css, worldW, worldH, obstacles);
      labels.push({ text, box: label });
      samples.push({ x: p.x, y: p.y, vx: mps(t.vx, scale), vy: mps(-t.vy, scale), speed, length, k, drawn, clipped: drawn < length, tip, label });
    }
    // The pill goes under the labels, so a label that had to land on it is still readable.
    paintScaleBar(ctx, css, bar);
    for (const l of labels) drawLabel(ctx, l.text, l.box, css);
    this.last = samples;
    this.scale = { k, vRef, hint: this.hint, bar: { mps: bar.mps, px: bar.px }, box: bar.box };
  }

  /** Top speed the factor is based on, m/s: the expected one, the fastest seen, or the fading seed without a hint. */
  private vRef(): number {
    const seed = this.hint > 0 ? 0 : SEED_MPS * Math.max(0, 1 - this.frames / SEED_FRAMES);
    return Math.max(this.hint, this.vMax, seed, MIN_VREF_MPS);
  }

  /** Show / hide with hysteresis; a sudden stop parks the arrow until a clear restart. */
  private updateShown(t: Track, b: Matter.Body, speed: number) {
    const vRef = this.vRef();
    const base = Math.max(SHOW_FRACTION * vRef, SHOW_MIN_MPS);
    const p = b.position;
    if (t.speed >= CRASH_FROM * vRef && speed <= CRASH_TO * vRef) {
      const bb = b.bounds;
      t.rest = { x: p.x, y: p.y, size: Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) };
      t.shown = false;
      t.below = 0;
      return;
    }
    if (t.shown) {
      if (speed < base) {
        if (++t.below >= HIDE_FRAMES) t.shown = false;
      } else t.below = 0;
      return;
    }
    let wake = speed >= SHOW_HYST * base;
    if (t.rest)
      wake = speed >= Math.max(SHOW_HYST * base, WAKE_FRACTION * vRef) || Math.hypot(p.x - t.rest.x, p.y - t.rest.y) >= WAKE_TRAVEL * t.rest.size;
    if (wake) {
      t.shown = true;
      t.below = 0;
      t.rest = null;
    }
  }

  /** Moving bodies' boxes plus the rope / spring lines, which a label must not sit on. */
  private obstacles(scene: BuiltScene, bodies: Matter.Body[], css: number): Obstacle[] {
    const m = 3 * css;
    const out: Obstacle[] = bodies.map((b) => ({
      box: { x: b.bounds.min.x - m, y: b.bounds.min.y - m, w: b.bounds.max.x - b.bounds.min.x + 2 * m, h: b.bounds.max.y - b.bounds.min.y + 2 * m },
    }));
    for (const sp of scene.sprites) {
      const f = sp.follow;
      if (f.kind === 'stretch') {
        const e = Matter.Constraint.pointBWorld(f.constraint);
        out.push({ seg: [f.anchor.x, f.anchor.y, e.x, e.y] });
      } else if (f.kind === 'swing') {
        out.push({ seg: [f.pivot.x, f.pivot.y, f.body.position.x, f.body.position.y] });
      }
    }
    return out;
  }
}

/** How far an arrow from (x, y) along (ux, uy) can go before it leaves the picture (minus an inset). */
function reachToEdge(x: number, y: number, ux: number, uy: number, w: number, h: number, inset: number): number {
  let t = Infinity;
  if (ux > 0) t = Math.min(t, (w - inset - x) / ux);
  else if (ux < 0) t = Math.min(t, (inset - x) / ux);
  if (uy > 0) t = Math.min(t, (h - inset - y) / uy);
  else if (uy < 0) t = Math.min(t, (inset - y) / uy);
  return t;
}

/** Draws the arrow; returns the head length used. */
function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, ux: number, uy: number, len: number, css: number): number {
  // The tip sits exactly at centre + v·k; a short arrow gets a smaller head so it never overshoots.
  const headLen = Math.min(HEAD_LEN_CSS * css, len * 0.6);
  const halfW = headLen * (HEAD_HALF_W_CSS / HEAD_LEN_CSS);
  const tipX = x + ux * len, tipY = y + uy * len;
  const baseX = tipX - ux * headLen, baseY = tipY - uy * headLen;
  const nx = -uy, ny = ux;
  const shaft = () => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(baseX + ux * 0.5 * css, baseY + uy * 0.5 * css);
    ctx.stroke();
  };
  const head = () => {
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX + nx * halfW, baseY + ny * halfW);
    ctx.lineTo(baseX - nx * halfW, baseY - ny * halfW);
    ctx.closePath();
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // White outline first so the arrow reads on top of pencil lines.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = (SHAFT_CSS + 2 * OUTLINE_CSS) * css;
  shaft();
  head();
  ctx.lineWidth = 2 * OUTLINE_CSS * css;
  ctx.stroke();
  ctx.strokeStyle = COLOR;
  ctx.fillStyle = COLOR;
  ctx.lineWidth = SHAFT_CSS * css;
  shaft();
  head();
  ctx.fill();
  // Centre dot marks where the arrow starts.
  ctx.beginPath();
  ctx.arc(x, y, 3.5 * css, 0, Math.PI * 2);
  ctx.lineWidth = 2 * css;
  ctx.strokeStyle = '#fff';
  ctx.fill();
  ctx.stroke();
  return headLen;
}

interface LabelSite {
  tip: { x: number; y: number };
  ux: number;
  uy: number;
  headLen: number;
  /** Arrow start (body centre) and the body's box, for arrows too short to leave the body. */
  origin: { x: number; y: number };
  body: Box;
}

/**
 * Where the speed label goes (box of w × h world px). Just past the tip when there is room; otherwise beside
 * the head, on the side with more room. Up/down arrows get the label beside the head straight away, so it
 * never sits on the rope, spring or body the arrow runs along. When the arrow is so short that all of that
 * would land on the body itself, the label moves just outside the body (ahead of it, else beside it).
 * Preference: close to the arrow and clear of everything; then clear of the scale bar at least; then merely
 * inside the picture. The label always stays inside the picture.
 */
function placeLabel(site: LabelSite, w: number, h: number, css: number, W: number, H: number, obstacles: Obstacle[]): Box {
  const { tip, ux, uy, headLen, origin, body } = site;
  const gap = LABEL_GAP_CSS * css;
  const pad = EDGE_PAD_CSS * css;
  // Half-extent of the box along a direction.
  const ext = (dx: number, dy: number) => (w / 2) * Math.abs(dx) + (h / 2) * Math.abs(dy);
  const ahead = { x: tip.x + ux * (gap + ext(ux, uy)), y: tip.y + uy * (gap + ext(ux, uy)) };
  const base = { x: tip.x - ux * headLen, y: tip.y - uy * headLen };
  const beside = (s: number) => {
    const nx = -uy * s, ny = ux * s;
    const d = gap + ext(nx, ny);
    return { x: base.x + nx * d, y: base.y + ny * d };
  };
  const bodyAhead = (() => {
    const d = exitBox(origin.x, origin.y, ux, uy, body) + gap + ext(ux, uy);
    return { x: origin.x + ux * d, y: origin.y + uy * d };
  })();
  const bodyBeside = (s: number) => {
    const nx = -uy * s, ny = ux * s;
    const d = exitBox(base.x, base.y, nx, ny, body) + gap + ext(nx, ny);
    return { x: base.x + nx * d, y: base.y + ny * d };
  };
  // More room to the picture's edges first; on a tie, the side nearer the middle of the picture.
  const room = (c: { x: number; y: number }) => Math.min(c.x, W - c.x, c.y, H - c.y);
  const bySide = (f: (s: number) => { x: number; y: number }) =>
    [f(1), f(-1)].sort((a, b) => room(b) - room(a) || Math.abs(a.x - W / 2) - Math.abs(b.x - W / 2));
  const vertical = Math.abs(uy) > 0.75;
  const order = vertical
    ? [...bySide(beside), bodyAhead, ...bySide(bodyBeside), ahead]
    : [ahead, ...bySide(beside), bodyAhead, ...bySide(bodyBeside)];
  const cands = order.map((c) => ({ x: c.x - w / 2, y: c.y - h / 2, w, h }));
  const fits = (b: Box) => b.x >= pad && b.y >= pad && b.x + b.w <= W - pad && b.y + b.h <= H - pad;
  const clearOf = (b: Box, hard: boolean) => !obstacles.some((o) => !!o.hard === hard && hits(o, b));
  const nearLimit = 1.5 * Math.max(w, h);
  const near = (b: Box) => Math.hypot(b.x + b.w / 2 - tip.x, b.y + b.h / 2 - tip.y) <= nearLimit;
  const best =
    cands.find((b) => fits(b) && clearOf(b, true) && clearOf(b, false) && near(b)) ??
    cands.find((b) => fits(b) && clearOf(b, true)) ??
    cands.find(fits);
  if (best) return best;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return { x: clamp(cands[0].x, pad, W - pad - w), y: clamp(cands[0].y, pad, H - pad - h), w, h };
}

/** Distance along (dx, dy) from a point inside the box to where the ray leaves it; 0 if the point is outside. */
function exitBox(ox: number, oy: number, dx: number, dy: number, b: Box): number {
  if (ox < b.x || ox > b.x + b.w || oy < b.y || oy > b.y + b.h) return 0;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (b.x + b.w - ox) / dx);
  else if (dx < 0) t = Math.min(t, (b.x - ox) / dx);
  if (dy > 0) t = Math.min(t, (b.y + b.h - oy) / dy);
  else if (dy < 0) t = Math.min(t, (b.y - oy) / dy);
  return Number.isFinite(t) ? t : 0;
}

function hits(o: Obstacle, b: Box): boolean {
  if ('box' in o) {
    const a = o.box;
    return b.x < a.x + a.w && b.x + b.w > a.x && b.y < a.y + a.h && b.y + b.h > a.y;
  }
  // Liang-Barsky: does the segment cross the box?
  const [x1, y1, x2, y2] = o.seg;
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, x1 - b.x) && clip(dx, b.x + b.w - x1) && clip(-dy, y1 - b.y) && clip(dy, b.y + b.h - y1);
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, box: Box, css: number) {
  ctx.font = `800 ${LABEL_CSS * css}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4 * css;
  ctx.strokeStyle = '#fff';
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ctx.strokeText(text, cx, cy);
  ctx.fillStyle = COLOR;
  ctx.fillText(text, cx, cy);
}

/** Largest 1 / 2 / 5 × 10ⁿ not above x. */
function niceBelow(x: number): number {
  if (!(x > 0)) return 0.1;
  const e = Math.floor(Math.log10(x));
  const m = x / 10 ** e;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * 10 ** e;
}

const fmt = (v: number) => Number(v.toPrecision(2)).toString();

interface ScaleBar {
  mps: number;
  px: number;
  text: string;
  /** The pill, world px. */
  box: Box;
  /** Left end of the line and its y; the text starts after the line. */
  lineX: number;
  textX: number;
  y: number;
}

const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });

/**
 * The most room the scale bar can ever take (world px): its line is at most 0.8 × Lmax (a round number of m/s
 * below 0.8 × vRef), its text at most as wide as "0.05 m/s". Other labels keep off this from the first frame.
 */
export function scaleBarZone(ctx: CanvasRenderingContext2D, css: number, W: number, H: number): Box {
  ctx.save();
  ctx.font = `800 ${LABEL_CSS * css}px ${FONT}`;
  const tw = ctx.measureText('0.05 m/s').width;
  ctx.restore();
  const px = 0.8 * LMAX_FRACTION * Math.min(W, H);
  const padX = 10 * css, padY = 6 * css, gap = 8 * css;
  const w = padX * 2 + px + gap + tw;
  const h = padY * 2 + LABEL_CSS * css;
  return { x: BAR_MARGIN_CSS * css, y: H - BAR_MARGIN_CSS * css - h, w, h };
}

/** Bottom-left pill: a line as long as a round number of m/s at the current factor, and that number. */
function layoutScaleBar(ctx: CanvasRenderingContext2D, css: number, H: number, k: number, vRef: number): ScaleBar {
  const mps = niceBelow(0.8 * vRef);
  const px = k * mps;
  const text = `${fmt(mps)} m/s`;
  const tw = ctx.measureText(text).width;
  const padX = 10 * css, padY = 6 * css, gap = 8 * css;
  const w = padX * 2 + px + gap + tw;
  const h = padY * 2 + LABEL_CSS * css;
  const x = BAR_MARGIN_CSS * css;
  const y = H - BAR_MARGIN_CSS * css - h;
  return { mps, px, text, box: { x, y, w, h }, lineX: x + padX, textX: x + padX + px + gap, y: y + h / 2 };
}

function paintScaleBar(ctx: CanvasRenderingContext2D, css: number, bar: ScaleBar) {
  const { x, y, w, h } = bar.box;
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.fill();
  ctx.lineWidth = 2 * css;
  ctx.strokeStyle = '#e5e5e5';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bar.lineX, bar.y);
  ctx.lineTo(bar.lineX + bar.px, bar.y);
  ctx.lineCap = 'round';
  ctx.lineWidth = SHAFT_CSS * css;
  ctx.strokeStyle = COLOR;
  ctx.stroke();
  ctx.font = `800 ${LABEL_CSS * css}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.fillText(bar.text, bar.textX, bar.y);
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const css = `
  .va-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; user-select: none; padding-top: 4px; }
  .va-toggle input { position: absolute; opacity: 0; pointer-events: none; }
  .va-text { display: flex; flex-direction: column; font-weight: 800; font-size: 16px; color: #3c3c3c; }
  .va-sub { font-size: 12px; font-weight: 700; color: #777; }
  .va-switch { position: relative; width: 52px; height: 30px; border-radius: 999px; background: #e5e5e5; transition: background 0.2s; flex-shrink: 0; }
  .va-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 2px 0 rgba(0,0,0,0.12); transition: transform 0.2s; }
  .va-toggle input:checked + .va-switch { background: ${COLOR}; }
  .va-toggle input:checked + .va-switch::after { transform: translateX(22px); }
  .va-toggle input:focus-visible + .va-switch { outline: 3px solid #ffb2b2; outline-offset: 2px; }
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}
