// Velocity arrows: one arrow per moving body of the drawing, from its centre in the direction it moves.
// Length is strictly proportional to the on-screen speed (the same look in every scene); the number is the
// physical speed (units.ts). Both come from the Simulation's MotionTracker, the same values the graph's Speed
// reads, so the arrow and the card always print the same number in the same frame.

import type { Simulation } from './sim';
import type { BuiltScene } from './types';
import { formatSpeed, mps, scaleOf, STEP_S } from './units';
import { WORK_SIZE } from './vision';

/**
 * Arrow length per on-screen speed: the tip is where the body would be this many screen seconds later.
 * 0.47 s keeps the look from before physical units (1 "m/s" = 1/20 of the 960 px picture at 1000/9.8 px/m):
 * a typical pendulum gets a ~100 px arrow, a fast cannon ball about a third of the picture.
 */
export const ARROW_SECONDS = WORK_SIZE / 20 / (1000 / 9.8);

const COLOR = '#ff4b4b';
/** Sizes in CSS px, converted to world px each frame so they look the same on any screen. */
const SHAFT_CSS = 4;
const OUTLINE_CSS = 2.5;
const HEAD_LEN_CSS = 13;
const HEAD_HALF_W_CSS = 8;
const LABEL_CSS = 12;

/** One drawn arrow (exposed for tests). Lengths in world px, speeds in m/s, `text` = the printed number. */
export interface ArrowSample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  length: number;
  text: string;
  /** Where the number was printed: centre and size in world px. */
  label?: { x: number; y: number; w: number; h: number };
}

type Box = { x: number; y: number; w: number; h: number };

export class VelocityArrows {
  enabled = true;
  private sim: Simulation | null = null;
  private input: HTMLInputElement | null = null;
  /** Arrows drawn in the last frame. */
  last: ArrowSample[] = [];
  /** Boxes (world px, this frame) the numbers should stay off when they can, e.g. the value labels. */
  avoid: () => Box[] = () => [];

  /** Hook into a freshly started simulation. */
  attach(sim: Simulation) {
    this.sim = sim;
    this.last = [];
    sim.drawListeners.push((ctx, scene, s) => {
      if (this.sim === sim) this.draw(sim, ctx, scene, s);
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
      if (!this.enabled) this.last = [];
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

  private draw(sim: Simulation, ctx: CanvasRenderingContext2D, scene: BuiltScene, pxScale: number) {
    const samples: ArrowSample[] = [];
    const scale = scaleOf(scene);
    // World px per CSS px.
    const css = (window.devicePixelRatio || 1) / pxScale;
    for (const b of sim.motion.bodies) {
      const t = sim.motion.get(b);
      if (!t || !t.shown || !this.enabled) continue;
      const v = Math.hypot(t.vx, t.vy); // px per step
      const length = (v / STEP_S) * ARROW_SECONDS;
      const speed = mps(v, scale);
      const text = formatSpeed(speed);
      const ux = t.vx / v, uy = t.vy / v;
      const p = b.position;
      drawArrow(ctx, p.x, p.y, ux, uy, length, css);
      const label = drawLabel(ctx, p.x, p.y, ux, uy, length, text, css, this.avoid());
      samples.push({ x: p.x, y: p.y, vx: mps(t.vx, scale), vy: mps(-t.vy, scale), speed, length, text, label });
    }
    this.last = samples;
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, ux: number, uy: number, len: number, css: number) {
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
}

/** True if the segment a-b passes through the box [x0, x1] × [y0, y1] (Liang-Barsky clipping). */
function segmentHitsBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
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
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay) && t0 <= t1;
}

/**
 * The speed just past the tip, on the side the arrow points to. When that would leave the picture (a block at the
 * edge, a ball flying out), the number moves beside the visible part of the arrow, or behind the body: always on
 * the picture and never on top of the arrow line, and off the value labels (`avoid`) whenever there is room.
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ux: number,
  uy: number,
  len: number,
  text: string,
  css: number,
  avoid: Box[],
): { x: number; y: number; w: number; h: number } {
  const size = LABEL_CSS * css;
  ctx.font = `800 ${size}px Nunito, "Avenir Next", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 4 * css; // + the white text outline
  const h = size + 2 * css;
  const gap = 8 * css;
  const pad = 4 * css;
  const worldW = ctx.canvas.width / ctx.getTransform().a;
  const worldH = ctx.canvas.height / ctx.getTransform().d;
  // Half the label's size measured along a direction: how far its centre must sit from a line to clear it.
  const ext = (dx: number, dy: number) => (Math.abs(dx) * w) / 2 + (Math.abs(dy) * h) / 2;
  const tipX = x + ux * len, tipY = y + uy * len;
  const nx = -uy, ny = ux;
  const inside = (cx: number, cy: number) =>
    cx - w / 2 >= pad && cx + w / 2 <= worldW - pad && cy - h / 2 >= pad && cy + h / 2 <= worldH - pad;
  // Centre line to the outer edge of the shaft's white outline, and of the head's.
  const shaftClear = (SHAFT_CSS / 2 + OUTLINE_CSS) * css;
  const headClear = (HEAD_HALF_W_CSS + OUTLINE_CSS) * css;
  const clearOfArrow = (cx: number, cy: number) =>
    !segmentHitsBox(x, y, tipX, tipY, cx - w / 2 - shaftClear, cy - h / 2 - shaftClear, cx + w / 2 + shaftClear, cy + h / 2 + shaftClear);

  const cands: [number, number][] = [];
  const along = gap + ext(ux, uy);
  const further = 2 * ext(ux, uy) + gap;
  cands.push([tipX + ux * along, tipY + uy * along]);
  // Beside the arrow (clear of the head too), from the tip back to the body; the side facing up first.
  const side = 4 * css + headClear + ext(nx, ny);
  const sides = ny <= 0 ? [1, -1] : [-1, 1];
  for (let k = 0; k <= 8; k++) {
    const t = len * (1 - k / 8);
    for (const s of sides) cands.push([x + ux * t + s * nx * side, y + uy * t + s * ny * side]);
  }
  cands.push([x - ux * along, y - uy * along]);
  // A step or two further out, ahead of the tip and behind the body (for tight corners).
  for (const k of [1, 2]) {
    cands.push([tipX + ux * (along + k * further), tipY + uy * (along + k * further)]);
    cands.push([x - ux * (along + k * further), y - uy * (along + k * further)]);
  }
  const offLabels = (cx: number, cy: number) =>
    !avoid.some((b) => cx - w / 2 < b.x + b.w && b.x < cx + w / 2 && cy - h / 2 < b.y + b.h && b.y < cy + h / 2);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  // Near the edge: the same spots slid onto the picture.
  const slid = cands.map(([cx, cy]): [number, number] => [clamp(cx, w / 2 + pad, worldW - w / 2 - pad), clamp(cy, h / 2 + pad, worldH - h / 2 - pad)]);
  let pick =
    cands.find(([cx, cy]) => inside(cx, cy) && clearOfArrow(cx, cy) && offLabels(cx, cy)) ??
    slid.find(([cx, cy]) => clearOfArrow(cx, cy) && offLabels(cx, cy)) ??
    cands.find(([cx, cy]) => inside(cx, cy) && clearOfArrow(cx, cy)) ??
    slid.find(([cx, cy]) => clearOfArrow(cx, cy));
  // Nowhere fits (tiny picture): the usual spot, kept on the picture.
  if (!pick) pick = slid[0];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4 * css;
  ctx.strokeStyle = '#fff';
  ctx.strokeText(text, pick[0], pick[1]);
  ctx.fillStyle = COLOR;
  ctx.fillText(text, pick[0], pick[1]);
  return { x: pick[0], y: pick[1], w, h };
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
