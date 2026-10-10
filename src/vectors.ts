// Velocity arrows: one arrow per moving body of the drawing, from its centre in the direction it moves.
// Length is strictly proportional to speed, with one factor for every scene, so arrows can be compared.

import type Matter from 'matter-js';
import { STEP_ACCEL, STEP_MS, type Simulation } from './sim';
import type { BuiltScene } from './types';
import { WORK_SIZE } from './vision';

/**
 * Arrow length per unit speed, in working-image px per (m/s): 1 m/s = 1/20 of the 960 px picture (48 px).
 * A typical pendulum (~2 m/s) gets a ~100 px arrow, a fast cannon ball (~7 m/s) about a third of the picture.
 */
export const ARROW_PX_PER_MPS = WORK_SIZE / 20;
const STEP_S = STEP_MS / 1000;
/** Same conversion as the graph: 9.8 m/s² is STEP_ACCEL px/step², so 1 m = 1000 / 9.8 px. */
const PX_PER_M = STEP_ACCEL / (STEP_S * STEP_S) / 9.8;
/** Hysteresis on speed (m/s) so a body at rest does not flicker an arrow on and off. */
const SHOW_MPS = 0.12;
const HIDE_MPS = 0.08;
/**
 * Light smoothing of the velocity vector (weight of the newest frame), only while slow: that is where
 * contact jitter would make a tiny arrow twitch. Above SMOOTH_BELOW_MPS the arrow is the exact velocity.
 */
const SMOOTH = 0.5;
const SMOOTH_BELOW_MPS = 0.5;
/** A jump larger than this (world px in one frame) is a reset/relaunch: drop the smoothing history. */
const JUMP_PX = 60;

const COLOR = '#ff4b4b';
/** Sizes in CSS px, converted to world px each frame so they look the same on any screen. */
const SHAFT_CSS = 4;
const OUTLINE_CSS = 2.5;
const HEAD_LEN_CSS = 13;
const HEAD_HALF_W_CSS = 8;
const LABEL_CSS = 12;

interface Track {
  vx: number; // px/step, smoothed
  vy: number;
  x: number;
  y: number;
  shown: boolean;
}

/** One drawn arrow (exposed for tests). Lengths in world px, speed in m/s. */
export interface ArrowSample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  length: number;
}

export class VelocityArrows {
  enabled = true;
  private tracks = new Map<Matter.Body, Track>();
  private sim: Simulation | null = null;
  private input: HTMLInputElement | null = null;
  /** Arrows drawn in the last frame. */
  last: ArrowSample[] = [];

  /** Hook into a freshly started simulation. */
  attach(sim: Simulation) {
    this.sim = sim;
    this.tracks.clear();
    this.last = [];
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
    const samples: ArrowSample[] = [];
    // World px per CSS px.
    const css = (window.devicePixelRatio || 1) / pxScale;
    for (const b of bodies) {
      const p = b.position;
      let t = this.tracks.get(b);
      if (!t || Math.hypot(p.x - t.x, p.y - t.y) > JUMP_PX) {
        t = { vx: b.velocity.x, vy: b.velocity.y, x: p.x, y: p.y, shown: false };
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
      const speed = Math.hypot(t.vx, t.vy) / STEP_S / PX_PER_M; // m/s
      t.shown = speed >= (t.shown ? HIDE_MPS : SHOW_MPS);
      if (!t.shown || !this.enabled) continue;
      const length = speed * ARROW_PX_PER_MPS;
      const ux = t.vx / Math.hypot(t.vx, t.vy);
      const uy = t.vy / Math.hypot(t.vx, t.vy);
      samples.push({ x: p.x, y: p.y, vx: (t.vx / STEP_S) / PX_PER_M, vy: (-t.vy / STEP_S) / PX_PER_M, speed, length });
      drawArrow(ctx, p.x, p.y, ux, uy, length, css);
      drawLabel(ctx, p.x + ux * length, p.y + uy * length, ux, uy, speed, css);
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

function drawLabel(ctx: CanvasRenderingContext2D, tipX: number, tipY: number, ux: number, uy: number, speed: number, css: number) {
  const text = `${speed.toFixed(1)} m/s`;
  const size = LABEL_CSS * css;
  ctx.font = `800 ${size}px Nunito, "Avenir Next", system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  // Just past the tip, on the side the arrow points to.
  const gap = 8 * css;
  // The arrow keeps its true length even past the edge, but the number always stays readable on the picture.
  const worldW = ctx.canvas.width / ctx.getTransform().a;
  const worldH = ctx.canvas.height / ctx.getTransform().d;
  const pad = 4 * css;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const cx = clamp(tipX + ux * (gap + w / 2), w / 2 + pad, worldW - w / 2 - pad);
  const cy = clamp(tipY + uy * (gap + size / 2), size / 2 + pad, worldH - size / 2 - pad);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4 * css;
  ctx.strokeStyle = '#fff';
  ctx.strokeText(text, cx, cy);
  ctx.fillStyle = COLOR;
  ctx.fillText(text, cx, cy);
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
