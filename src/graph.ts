// Live readout under the simulation: energy graph in joules (last 8 s on screen), period / speed, and Moon mode.
// Reads everything from the running Simulation each step; keeps no gravity state of its own. Every number is in
// physical units through units.ts (the scene's px per metre and slow-motion factor).

import Matter from 'matter-js';
import type { Simulation } from './sim';
import type { DiagramType, Scale } from './types';
import {
  DEFAULT_KG,
  DEFAULT_SCALE,
  EARTH_G,
  formatEnergy,
  formatSeconds,
  formatSpeed,
  massesOf,
  meters,
  mps,
  OMEGA2_PER_STIFFNESS,
  physSeconds,
  scaleOf,
  springK,
  STEP_S,
} from './units';

const WINDOW_S = 8;
const MAX_SAMPLES = Math.round(WINDOW_S / STEP_S);
const MOON_G = 1.62;

const GREEN = '#58cc02';
const BLUE = '#1cb0f6';
const ORANGE = '#ff9600';

interface Sample {
  ke: number;
  pe: number;
}

/**
 * Where potential energy is zero. The swap between kinetic and potential should fill the graph, so PE is
 * measured from the lowest point the moving body can reach, not from the bottom of the picture:
 *  - pendulum: the bottom of the swing (pivot + string length straight down), fixed;
 *  - spring:   the rest (equilibrium) position: gravity and spring together give ½ k d², d from rest;
 *  - window:   anything else, the lowest PE in the last 8 s on screen (subtracted when drawing).
 */
type PeRef = { kind: 'pendulum'; bottomY: number } | { kind: 'spring' } | { kind: 'window' };

const PE_REF_TEXT: Record<PeRef['kind'], string> = {
  pendulum: 'PE from lowest point',
  spring: 'PE from rest position',
  window: 'PE from lowest point shown',
};

/** Upper end of the energy axis: the last 8 s peak times this. */
const HEADROOM = 1.15;

export class LiveGraph {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private metricLabel: HTMLSpanElement;
  private metricValue: HTMLSpanElement;
  private theoryLabel: HTMLSpanElement;
  private moon: HTMLInputElement;
  private gLabel: HTMLSpanElement;

  private sim: Simulation | null = null;
  private diagram: DiagramType = 'fallback';
  private scale: Scale = DEFAULT_SCALE;
  private kg = new Map<Matter.Body, number>();
  private samples: Sample[] = [];
  private yMax = 0;
  private peRef: PeRef = { kind: 'window' };
  /** Screen seconds since the drawing started (the period meter works in screen time). */
  private time = 0;
  private period = new PeriodMeter();
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
          <span class="lg-theory" hidden></span>
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
      </div>
      <div class="lg-wait">Waiting for the drawing…</div>`;
    after.insertAdjacentElement('afterend', this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.metricLabel = this.root.querySelector('.lg-metric-label')!;
    this.metricValue = this.root.querySelector('.lg-metric-value')!;
    this.theoryLabel = this.root.querySelector('.lg-theory')!;
    this.moon = this.root.querySelector('input')!;
    this.gLabel = this.root.querySelector('.lg-g')!;
    this.moon.addEventListener('change', () => {
      this.sim?.setParams({ gravity: this.moon.checked ? MOON_G : EARTH_G });
      this.syncGravity();
    });
  }

  /**
   * A new photo is on its way: stop following the old drawing and hide its numbers and curves. The card keeps
   * its size (no jump in the layout below) and shows a quiet placeholder until the next attach().
   */
  reset() {
    this.sim = null;
    this.samples = [];
    this.root.classList.add('lg-waiting');
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.metricValue.textContent = '--';
  }

  attach(sim: Simulation, diagram: DiagramType) {
    this.sim = sim;
    this.root.classList.remove('lg-waiting');
    this.diagram = diagram;
    this.scale = scaleOf(sim.scene);
    this.kg = massesOf(sim.scene);
    this.samples = [];
    this.yMax = 0;
    this.time = 0;
    this.peRef = peRefOf(sim, diagram);
    // Released from rest = the start is a turning point. A spring (or a pendulum drawn hanging straight) starts
    // with a push through the middle instead, so its first gap to a turning point is only a quarter swing.
    const main = mainBody(Matter.Composite.allBodies(sim.engine.world).filter((b) => !b.isStatic));
    this.period.reset(!main || Math.hypot(main.velocity.x, main.velocity.y) < PeriodMeter.MIN_V);
    this.lastG = NaN;
    this.root.hidden = false;
    this.metricLabel.textContent = this.measuresPeriod() ? 'Period' : 'Speed';
    this.metricValue.textContent = '--';
    // If Moon mode was on for the previous drawing, keep it on for the new one.
    if (this.moon.checked) sim.setParams({ gravity: MOON_G });
    this.syncGravity();
    this.showTheory();
    sim.stepListeners.push((engine) => this.onStep(sim, engine));
  }

  /**
   * The textbook period next to the measured one: pendulum 2π√(L/g) with the drawn string length, spring
   * 2π√(m/k) with the simulated k. Follows gravity changes (slider, Moon mode).
   */
  private showTheory() {
    const sim = this.sim;
    let text = '';
    if (sim && this.diagram === 'pendulum' && sim.scene.label === 'Pendulum' && sim.scene.measures?.string) {
      const L = meters(sim.scene.measures.string, this.scale);
      const g = sim.gravity;
      text = `Theory 2π√(L/g) = ${g > 0 ? formatSeconds(2 * Math.PI * Math.sqrt(L / g)) : '--'}`;
    } else if (sim && this.diagram === 'spring' && sim.scene.label === 'Spring and mass') {
      const c = sim.scene.constraints[0];
      const block = sim.scene.parts?.block;
      if (c && block) {
        const m = block.kg ?? DEFAULT_KG;
        const k = springK(c.stiffness, m, this.scale);
        text = `Theory 2π√(m/k) = ${formatSeconds(2 * Math.PI * Math.sqrt(m / k))}`;
      }
    }
    this.theoryLabel.textContent = text;
    this.theoryLabel.hidden = !text;
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
    if (changed) this.showTheory();
    // Old periods were measured under the old gravity. Until the next half swing is measured, show
    // a provisional estimate: a pendulum's period goes as 1/sqrt(g); a spring's does not depend on g.
    if (changed && this.measuresPeriod()) {
      const old = this.period.value();
      const guess = old ? (this.diagram === 'pendulum' ? old.period * Math.sqrt(oldG / g) : old.period) : null;
      this.period.restart(guess);
      this.showPeriod();
    }
  }

  /** Measured period, converted from screen seconds to physical seconds. */
  private showPeriod() {
    const p = this.period.value();
    const T = p ? physSeconds(p.period, this.scale) : 0;
    this.metricValue.textContent = !p ? '--' : p.provisional ? `~${T.toFixed(T < 1 ? 2 : 1)} s` : formatSeconds(T);
  }

  private onStep(sim: Simulation, engine: Matter.Engine) {
    if (this.sim !== sim) return; // a newer drawing has replaced this one
    this.time += STEP_S;
    this.syncGravity();
    const g = sim.gravity;
    const bodies = Matter.Composite.allBodies(engine.world).filter((b) => !b.isStatic);

    // Joules: written or assumed (1 kg) masses, speeds and heights in metres through the scene's scale.
    let ke = 0;
    let pe = 0;
    const ref = this.peRef;
    for (const b of bodies) {
      const kg = this.kg.get(b) ?? DEFAULT_KG;
      const v = mps(Math.hypot(b.velocity.x, b.velocity.y), this.scale);
      ke += 0.5 * kg * v * v;
      if (ref.kind === 'spring') continue; // gravity is inside ½ k d² below
      // Height above the bottom of the swing (pendulum) or the bottom edge (window: offset when drawing).
      const baseY = ref.kind === 'pendulum' ? ref.bottomY : sim.worldH;
      pe += kg * g * Math.max(0, meters(baseY - b.position.y, this.scale));
    }
    pe += ref.kind === 'spring' ? springEnergyFromRest(engine, this.scale, this.kg) : springEnergy(engine, this.scale, this.kg);
    this.samples.push({ ke, pe });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    if (this.measuresPeriod()) {
      const main = mainBody(bodies);
      if (main) this.period.push(this.time, main);
      this.showPeriod();
    } else {
      // Same tracker, same body, same conversion and formatter as the velocity arrow's number.
      const f = sim.motion.fastest();
      this.metricValue.textContent = f ? formatSpeed(mps(Math.hypot(f.track.vx, f.track.vy), this.scale)) : '--';
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

    // 'window': PE is zero at the lowest point of the last 8 s (one offset for the whole plotted window, so
    // the total stays flat where energy is conserved).
    let peZero = 0;
    if (this.peRef.kind === 'window' && this.samples.length) {
      peZero = Infinity;
      for (const s of this.samples) peZero = Math.min(peZero, s.pe);
    }
    const pe = (s: Sample) => Math.max(0, s.pe - peZero);

    // Axis from 0 J to the last 8 s peak × HEADROOM: jumps up at once, eases down slowly (never a sudden shrink).
    let peak = 0;
    for (const s of this.samples) peak = Math.max(peak, s.ke + pe(s));
    const target = peak * HEADROOM;
    this.yMax = target > this.yMax ? target : this.yMax + (target - this.yMax) * 0.01;
    const yMax = this.yMax > 1e-9 ? this.yMax : 1;

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
    // The window is 8 s on screen; the axis is in physical time like every other readout.
    const span = physSeconds(WINDOW_S, this.scale);
    ctx.fillText(`-${span < 10 ? span.toFixed(1) : span.toFixed(0)} s`, left, cssH - 4);
    // Where PE is zero, small, between the time labels (clear of the curves).
    ctx.font = '700 10px Nunito, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(PE_REF_TEXT[this.peRef.kind], (left + right) / 2, cssH - 4);
    ctx.font = '800 11px Nunito, system-ui, sans-serif';
    ctx.save();
    ctx.translate(13, top + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Energy (J)', 0, 0);
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
    plot(ORANGE, pe);
    plot(BLUE, (s) => s.ke);
    plot(GREEN, (s) => s.ke + pe(s));
    // Top of the scale, so the joules can be read off; on a white halo above the curves.
    ctx.font = '800 11px Nunito, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(formatEnergy(yMax), left + 6, top + 2);
    ctx.fillStyle = '#999';
    ctx.fillText(formatEnergy(yMax), left + 6, top + 2);
  }
}

/**
 * Measures the period of an oscillating body from its turning points:
 * the velocity along the main swing axis flips sign twice per period, so each gap between
 * flips is half a period. The release from rest counts as the first turning point, so a
 * provisional reading appears after one half swing; it is confirmed after two and then averaged.
 */
class PeriodMeter {
  /** px/step: slower than this along the swing axis is jitter around rest. */
  static readonly MIN_V = 0.03;
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

  /** A new drawing. Released from rest: the release counts as the first turning point; pushed: it does not. */
  reset(fromRest = true) {
    this.xs = [];
    this.ys = [];
    this.prevV = 0;
    this.sign = 0;
    this.lastFlip = NaN;
    this.halves = [];
    this.fromRest = fromRest;
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
    const minV = PeriodMeter.MIN_V;
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

/**
 * Elastic energy stored in soft constraints (drawn springs), in joules: ½ k x² with the physical k that the
 * constraint has for the body's mass (units.ts: ω² ≈ OMEGA2_PER_STIFFNESS × stiffness per step²).
 */
function springEnergy(engine: Matter.Engine, scale: Scale, kg: Map<Matter.Body, number>): number {
  let e = 0;
  for (const c of Matter.Composite.allConstraints(engine.world)) {
    if (c.stiffness >= 0.1) continue; // rigid ropes / pins store no energy
    const ends = [c.bodyA, c.bodyB].filter((b): b is Matter.Body => !!b && !b.isStatic);
    if (!ends.length) continue;
    const ms = ends.map((b) => kg.get(b) ?? DEFAULT_KG);
    const m = ms.length === 2 ? (ms[0] * ms[1]) / (ms[0] + ms[1]) : ms[0];
    const a = Matter.Constraint.pointAWorld(c);
    const b = Matter.Constraint.pointBWorld(c);
    const stretch = meters(Math.hypot(b.x - a.x, b.y - a.y) - c.length, scale);
    e += 0.5 * springK(c.stiffness, m, scale) * stretch * stretch;
  }
  return e;
}

/** Where PE is zero for this drawing (see PeRef). Falls back to the 8 s window when the scene is not the expected one. */
function peRefOf(sim: Simulation, diagram: DiagramType): PeRef {
  const scene = sim.scene;
  if (diagram === 'pendulum' && scene.label === 'Pendulum') {
    const swing = scene.sprites.find((s) => s.follow.kind === 'swing')?.follow;
    const L = scene.measures?.string;
    if (swing?.kind === 'swing' && L) return { kind: 'pendulum', bottomY: swing.pivot.y + L };
  }
  if (diagram === 'spring' && scene.label === 'Spring and mass' && scene.constraints.some((c) => c.stiffness < 0.1))
    return { kind: 'spring' };
  return { kind: 'window' };
}

/**
 * Potential energy of a mass on a drawn spring measured from its rest position, in joules: ½ k d², d = how far
 * the spring end is from where gravity and spring balance (rest length + g along the spring / ω²). Gravity's
 * share is inside this: m g h + ½ k x² is ½ k d² plus a constant.
 */
function springEnergyFromRest(engine: Matter.Engine, scale: Scale, kg: Map<Matter.Body, number>): number {
  const g = engine.gravity;
  const toStep = g.scale * (STEP_S * 1000) ** 2;
  let e = 0;
  for (const c of Matter.Composite.allConstraints(engine.world)) {
    if (c.stiffness >= 0.1) continue;
    const ends = [c.bodyA, c.bodyB].filter((b): b is Matter.Body => !!b && !b.isStatic);
    if (!ends.length) continue;
    const ms = ends.map((b) => kg.get(b) ?? DEFAULT_KG);
    const m = ms.length === 2 ? (ms[0] * ms[1]) / (ms[0] + ms[1]) : ms[0];
    const a = Matter.Constraint.pointAWorld(c);
    const b = Matter.Constraint.pointBWorld(c);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    // Gravity along the spring (towards the moving end), px per step², over ω² per step² = the sag in px.
    const ga = ((g.x * (b.x - a.x) + g.y * (b.y - a.y)) / len) * toStep;
    const rest = c.length + ga / (OMEGA2_PER_STIFFNESS * c.stiffness);
    const d = meters(len - rest, scale);
    e += 0.5 * springK(c.stiffness, m, scale) * d * d;
  }
  return e;
}

/** The body whose swing is timed: the heaviest moving one (the bob, the spring's block). */
function mainBody(bodies: Matter.Body[]): Matter.Body | null {
  return bodies.reduce<Matter.Body | null>((a, b) => (!a || b.mass > a.mass ? b : a), null);
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
  .lg-card { position: relative; }
  .lg-card.lg-waiting > :not(.lg-wait) { visibility: hidden; }
  .lg-wait { display: none; position: absolute; inset: 0; align-items: center; justify-content: center; font-size: 15px; font-weight: 800; color: #afafaf; }
  .lg-card.lg-waiting .lg-wait { display: flex; }
  .lg-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .lg-metric { display: flex; flex-direction: column; min-width: 0; }
  .lg-metric-label { font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #afafaf; }
  .lg-metric-value { font-size: 30px; font-weight: 900; color: #3c3c3c; line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .lg-moon { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; flex-shrink: 0; }
  .lg-moon input { position: absolute; opacity: 0; pointer-events: none; }
  .lg-moon-text { display: flex; flex-direction: column; align-items: flex-end; font-weight: 800; font-size: 15px; color: #3c3c3c; }
  .lg-g { font-size: 12px; font-weight: 700; color: #777; }
  .lg-theory { margin-top: 2px; font-size: 12px; font-weight: 800; color: #1899d6; font-variant-numeric: tabular-nums; }
  .lg-theory[hidden] { display: none; }
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
