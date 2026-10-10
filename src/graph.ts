// Live readout under the simulation: energy graph (last 8 s), period / speed, and Moon mode.
// Reads everything from the running Simulation each step; keeps no gravity state of its own.

import Matter from 'matter-js';
import { STEP_ACCEL, STEP_MS, type Simulation } from './sim';
import type { DiagramType } from './types';

const WINDOW_S = 8;
const STEP_S = STEP_MS / 1000;
const MAX_SAMPLES = Math.round(WINDOW_S / STEP_S);
/** 9.8 m/s² is STEP_ACCEL px/step² in the sim, so this many px make one metre. */
const PX_PER_M = STEP_ACCEL / (STEP_S * STEP_S) / 9.8;
const EARTH_G = 9.8;
const MOON_G = 1.62;

const GREEN = '#58cc02';
const BLUE = '#1cb0f6';
const ORANGE = '#ff9600';

interface Sample {
  ke: number;
  pe: number;
}

export class LiveGraph {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private metricLabel: HTMLSpanElement;
  private metricValue: HTMLSpanElement;
  private moon: HTMLInputElement;
  private gLabel: HTMLSpanElement;

  private sim: Simulation | null = null;
  private diagram: DiagramType = 'fallback';
  private samples: Sample[] = [];
  private yMax = 0;
  private time = 0;
  private period = new PeriodMeter();
  private speed = 0;
  private lastG = NaN;

  constructor(after: HTMLElement) {
    injectStyle();
    this.root = document.createElement('div');
    this.root.className = 'lg-card';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="lg-top">
        <div class="lg-metric">
          <span class="lg-metric-label"></span>
          <span class="lg-metric-value">--</span>
        </div>
        <label class="lg-moon">
          <span class="lg-moon-text">Moon mode<span class="lg-g"></span></span>
          <input type="checkbox" />
          <span class="lg-switch"></span>
        </label>
      </div>
      <canvas class="lg-canvas"></canvas>
      <div class="lg-legend">
        <span><i style="background:${BLUE}"></i>Kinetic</span>
        <span><i style="background:${ORANGE}"></i>Potential</span>
        <span><i style="background:${GREEN}"></i>Total</span>
      </div>`;
    after.insertAdjacentElement('afterend', this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.metricLabel = this.root.querySelector('.lg-metric-label')!;
    this.metricValue = this.root.querySelector('.lg-metric-value')!;
    this.moon = this.root.querySelector('input')!;
    this.gLabel = this.root.querySelector('.lg-g')!;
    this.moon.addEventListener('change', () => {
      this.sim?.setParams({ gravity: this.moon.checked ? MOON_G : EARTH_G });
      this.syncGravity();
    });
  }

  attach(sim: Simulation, diagram: DiagramType) {
    this.sim = sim;
    this.diagram = diagram;
    this.samples = [];
    this.yMax = 0;
    this.time = 0;
    this.speed = 0;
    this.period.reset();
    this.lastG = NaN;
    this.root.hidden = false;
    this.metricLabel.textContent = this.measuresPeriod() ? 'Period' : 'Speed';
    this.metricValue.textContent = '--';
    // If Moon mode was on for the previous drawing, keep it on for the new one.
    if (this.moon.checked) sim.setParams({ gravity: MOON_G });
    this.syncGravity();
    sim.stepListeners.push((engine) => this.onStep(sim, engine));
  }

  private measuresPeriod() {
    return this.diagram === 'pendulum' || this.diagram === 'spring';
  }

  /** Reflects the sim's gravity (which a slider may also change) in the toggle and page tint. */
  private syncGravity() {
    const g = this.sim?.gravity ?? EARTH_G;
    if (g === this.lastG) return;
    const changed = !Number.isNaN(this.lastG);
    const oldG = this.lastG;
    this.lastG = g;
    const isMoon = Math.abs(g - MOON_G) < 0.05;
    this.moon.checked = isMoon;
    document.body.classList.toggle('lg-moon-on', isMoon);
    this.gLabel.textContent = `g = ${g.toFixed(g < 10 ? 2 : 1)} m/s²`;
    // Old periods were measured under the old gravity. Until the next half swing is measured, show
    // a provisional estimate: a pendulum's period goes as 1/sqrt(g); a spring's does not depend on g.
    if (changed && this.measuresPeriod()) {
      const old = this.period.value();
      const guess = old ? (this.diagram === 'pendulum' ? old.period * Math.sqrt(oldG / g) : old.period) : null;
      this.period.restart(guess);
      this.showPeriod();
    }
  }

  private showPeriod() {
    const p = this.period.value();
    this.metricValue.textContent = !p ? '--' : p.provisional ? `~${p.period.toFixed(1)} s` : `${p.period.toFixed(2)} s`;
  }

  private onStep(sim: Simulation, engine: Matter.Engine) {
    if (this.sim !== sim) return; // a newer drawing has replaced this one
    this.time += STEP_S;
    this.syncGravity();
    const g = sim.gravity;
    const bodies = Matter.Composite.allBodies(engine.world).filter((b) => !b.isStatic);

    let ke = 0;
    let pe = 0;
    let fastest = 0;
    for (const b of bodies) {
      const v = (Math.hypot(b.velocity.x, b.velocity.y) / STEP_S) / PX_PER_M; // m/s
      const h = (sim.worldH - b.position.y) / PX_PER_M; // m above the bottom edge
      ke += 0.5 * b.mass * v * v;
      pe += b.mass * g * h;
      fastest = Math.max(fastest, v);
    }
    pe += springEnergy(engine);
    this.samples.push({ ke, pe });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    if (this.measuresPeriod()) {
      const main = bodies.reduce<Matter.Body | null>((a, b) => (!a || b.mass > a.mass ? b : a), null);
      if (main) this.period.push(this.time, main);
      this.showPeriod();
    } else {
      this.speed += (fastest - this.speed) * 0.15;
      this.metricValue.textContent = `${this.speed.toFixed(1)} m/s`;
    }
    this.draw();
  }

  private draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = 120;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const left = 22;
    const right = cssW - 4;
    const top = 6;
    const bottom = cssH - 18;
    const w = right - left;
    const h = bottom - top;

    // Smooth auto-scale: jump up immediately, ease down slowly.
    let peak = 0;
    for (const s of this.samples) peak = Math.max(peak, s.ke + s.pe);
    this.yMax = peak > this.yMax ? peak * 1.1 : this.yMax + (peak * 1.1 - this.yMax) * 0.01;
    const yMax = this.yMax || 1;

    // Grid + axes.
    ctx.strokeStyle = '#eeeeee';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let k = 1; k <= 3; k++) {
      const y = top + (h * k) / 4;
      line(ctx, left, y, right, y);
    }
    ctx.strokeStyle = '#e0e0e0';
    line(ctx, left, top, left, bottom);
    line(ctx, left, bottom, right, bottom);

    ctx.fillStyle = '#afafaf';
    ctx.font = '800 11px Nunito, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.fillText('now', right, cssH - 4);
    ctx.textAlign = 'left';
    ctx.fillText(`-${WINDOW_S} s`, left, cssH - 4);
    ctx.save();
    ctx.translate(13, top + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Energy', 0, 0);
    ctx.restore();

    const n = this.samples.length;
    if (n < 2) return;
    const x0 = right - ((n - 1) / (MAX_SAMPLES - 1)) * w;
    const dx = w / (MAX_SAMPLES - 1);
    const plot = (color: string, f: (s: Sample) => number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      this.samples.forEach((s, i) => {
        const y = bottom - Math.min(1, Math.max(0, f(s) / yMax)) * h;
        if (i) ctx.lineTo(x0 + i * dx, y);
        else ctx.moveTo(x0, y);
      });
      ctx.stroke();
    };
    plot(ORANGE, (s) => s.pe);
    plot(BLUE, (s) => s.ke);
    plot(GREEN, (s) => s.ke + s.pe);
  }
}

/**
 * Measures the period of an oscillating body from its turning points:
 * the velocity along the main swing axis flips sign twice per period, so each gap between
 * flips is half a period. The release from rest counts as the first turning point, so a
 * provisional reading appears after one half swing; it is confirmed after two and then averaged.
 */
class PeriodMeter {
  private xs: number[] = [];
  private ys: number[] = [];
  private prevV = 0;
  private sign = 0;
  private lastFlip = NaN;
  private halves: number[] = [];
  /** True until the first motion after a fresh start: a body released from rest starts at a turning point. */
  private fromRest = true;
  /** Shown (as provisional) until a half swing is measured, e.g. the Earth period scaled to the Moon. */
  private guess: number | null = null;

  /** A new drawing: the body is released from rest, so the release counts as the first turning point. */
  reset() {
    this.xs = [];
    this.ys = [];
    this.prevV = 0;
    this.sign = 0;
    this.lastFlip = NaN;
    this.halves = [];
    this.fromRest = true;
    this.guess = null;
  }

  /**
   * Gravity changed mid-swing: old readings no longer apply, but keep tracking the motion so the
   * next turning point starts a fresh half swing. `guess` is shown meanwhile (provisional).
   */
  restart(guess: number | null) {
    this.lastFlip = NaN;
    this.halves = [];
    this.fromRest = false;
    this.guess = guess;
  }

  push(t: number, body: Matter.Body) {
    this.xs.push(body.position.x);
    this.ys.push(body.position.y);
    if (this.xs.length > 240) {
      this.xs.shift();
      this.ys.shift();
    }
    if (this.fromRest && this.xs.length === 1) this.lastFlip = t - STEP_S;
    // Swing axis = whichever coordinate moves more (x for a pendulum, along the spring for a spring).
    const useX = range(this.xs) >= range(this.ys);
    const v = useX ? body.velocity.x : body.velocity.y;
    const minV = 0.03; // px/step: ignore jitter around rest
    const s = v > minV ? 1 : v < -minV ? -1 : 0;
    if (s !== 0 && this.sign !== 0 && s !== this.sign) {
      // Interpolate the exact zero crossing between the two steps.
      const dv = this.prevV - v;
      const tc = dv !== 0 ? t - STEP_S + (STEP_S * this.prevV) / dv : t;
      if (!Number.isNaN(this.lastFlip)) {
        const half = tc - this.lastFlip;
        if (half > 0.08 && half < 15) {
          this.halves.push(half);
          if (this.halves.length > 4) this.halves.shift();
        }
      }
      this.lastFlip = tc;
    }
    if (s !== 0) {
      this.sign = s;
      this.fromRest = false;
    }
    this.prevV = v;
  }

  /** Period in seconds; `provisional` until two half swings have been measured. */
  value(): { period: number; provisional: boolean } | null {
    if (!this.halves.length) return this.guess ? { period: this.guess, provisional: true } : null;
    const period = (2 * this.halves.reduce((a, b) => a + b, 0)) / this.halves.length;
    return { period, provisional: this.halves.length < 2 };
  }
}

/** Matter 0.20 (2 constraint iterations): a soft constraint acts like k ≈ 6.6 × stiffness × mass per step². */
const SPRING_K_PER_STIFFNESS = 6.6;

/** Elastic energy stored in soft constraints (drawn springs), in the same units as KE / PE. */
function springEnergy(engine: Matter.Engine): number {
  let e = 0;
  for (const c of Matter.Composite.allConstraints(engine.world)) {
    if (c.stiffness >= 0.1) continue; // rigid ropes / pins store no energy
    const ends = [c.bodyA, c.bodyB].filter((b): b is Matter.Body => !!b && !b.isStatic);
    if (!ends.length) continue;
    const m = ends.length === 2 ? (ends[0].mass * ends[1].mass) / (ends[0].mass + ends[1].mass) : ends[0].mass;
    const a = Matter.Constraint.pointAWorld(c);
    const b = Matter.Constraint.pointBWorld(c);
    const stretch = (Math.hypot(b.x - a.x, b.y - a.y) - c.length) / PX_PER_M; // m
    const k = (SPRING_K_PER_STIFFNESS * c.stiffness * m) / (STEP_S * STEP_S); // per s²
    e += 0.5 * k * stretch * stretch;
  }
  return e;
}

function range(a: number[]) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of a) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi - lo;
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const css = `
  body { transition: background-color 0.4s; }
  body.lg-moon-on { background: #d9d9de; }
  body.lg-moon-on #stage { filter: grayscale(0.35) brightness(0.93); }
  #stage { transition: filter 0.4s; }
  .lg-card { background: #fff; border: 2px solid #e5e5e5; border-bottom-width: 4px; border-radius: 20px; padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 8px; }
  .lg-card[hidden] { display: none; }
  .lg-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .lg-metric { display: flex; flex-direction: column; min-width: 0; }
  .lg-metric-label { font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #afafaf; }
  .lg-metric-value { font-size: 30px; font-weight: 900; color: #3c3c3c; line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .lg-moon { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; flex-shrink: 0; }
  .lg-moon input { position: absolute; opacity: 0; pointer-events: none; }
  .lg-moon-text { display: flex; flex-direction: column; align-items: flex-end; font-weight: 800; font-size: 15px; color: #3c3c3c; }
  .lg-g { font-size: 12px; font-weight: 700; color: #777; }
  .lg-switch { position: relative; width: 52px; height: 30px; border-radius: 999px; background: #e5e5e5; transition: background 0.2s; flex-shrink: 0; }
  .lg-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 2px 0 rgba(0,0,0,0.12); transition: transform 0.2s; }
  .lg-moon input:checked + .lg-switch { background: #1cb0f6; }
  .lg-moon input:checked + .lg-switch::after { transform: translateX(22px); }
  .lg-moon input:focus-visible + .lg-switch { outline: 3px solid #84d8ff; outline-offset: 2px; }
  .lg-canvas { display: block; width: 100%; height: 120px; }
  .lg-legend { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; font-size: 13px; font-weight: 800; color: #777; }
  .lg-legend i { display: inline-block; width: 12px; height: 4px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}
