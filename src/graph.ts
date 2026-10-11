// Live readout under the simulation: energy graph in joules (last 8 s on screen), period / speed, and Moon mode.
// A seesaw shows its torque balance instead: the moment m·g·d of each side as a bar, and which side wins.
// Reads everything from the running Simulation each step; keeps no gravity state of its own. Every number is in
// physical units through units.ts (the scene's px per metre and slow-motion factor).

import Matter from 'matter-js';
import type { Simulation } from './sim';
import type { DiagramType, LeverInfo, LeverSide, Scale } from './types';
import { rollAccel } from './scenes/roll';
import { DEFAULT_FRICTION } from './scenes/incline';
import {
  BASE_SCALE,
  DEFAULT_KG,
  DEFAULT_SCALE,
  EARTH_G,
  formatEnergy,
  formatLength,
  formatMass,
  formatSeconds,
  formatSpeed,
  massesOf,
  meters,
  mps,
  physSeconds,
  scaleOf,
  springK,
  STEP_MS,
  STEP_S,
} from './units';

const WINDOW_S = 8;
const MAX_SAMPLES = Math.round(WINDOW_S / STEP_S);
const MOON_G = 1.62;

const GREEN = '#58cc02';
const BLUE = '#1cb0f6';
const ORANGE = '#ff9600';
const PURPLE = '#ce82ff';

const ENERGY_LEGEND = `
        <span><i style="background:${BLUE}"></i>Kinetic</span>
        <span><i style="background:${ORANGE}"></i>Potential</span>
        <span><i style="background:${GREEN}"></i>Total</span>`;
const MOMENTUM_LEGEND = `
        <span><i style="background:${ORANGE}"></i>Left p</span>
        <span><i style="background:${BLUE}"></i>Right p</span>
        <span><i style="background:${GREEN}"></i>Total p</span>
        <span><i style="background:${PURPLE}"></i>Kinetic energy</span>`;
const TORQUE_LEGEND = `
        <span>Moment = m · g · d (N·m)</span>`;

/** Ball collision: momentum of each ball (kg·m/s, right = +) and the kinetic energy of both (J). */
interface MomentumSample {
  p1: number;
  p2: number;
  ke: number;
}

/** "1.23 kg·m/s" (signed). */
export const formatMomentum = (p: number) => `${Math.abs(p) < 10 ? p.toFixed(2) : p.toFixed(1)} kg·m/s`;

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
  /** Ball collision on screen: the two balls and their masses (the card shows momentum instead of energy). */
  private balls: { bodies: [Matter.Body, Matter.Body]; kg: [number, number] } | null = null;
  private mSamples: MomentumSample[] = [];
  private pMax = 0;
  private keMax = 0;
  private legend: HTMLDivElement;
  /** Seesaw on screen: its sides, for the torque bars instead of the energy graph. */
  private lever: LeverInfo | null = null;

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
      <div class="lg-legend">${ENERGY_LEGEND}
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
    this.legend = this.root.querySelector('.lg-legend')!;
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
    this.metricValue.classList.remove('lg-long');
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
    this.lever = diagram === 'lever' && sim.scene.label === 'Seesaw' ? sim.scene.physics?.lever ?? null : null;
    // Released from rest = the start is a turning point. A spring (or a pendulum drawn hanging straight) starts
    // with a push through the middle instead, so its first gap to a turning point is only a quarter swing.
    const main = mainBody(Matter.Composite.allBodies(sim.engine.world).filter((b) => !b.isStatic));
    this.period.reset(!main || Math.hypot(main.velocity.x, main.velocity.y) < PeriodMeter.MIN_V);
    this.lastG = NaN;
    this.root.hidden = false;
    // Two balls colliding: momentum (each ball and the total, which a hit never changes) and the kinetic energy.
    const left = sim.scene.parts?.['left ball'], right = sim.scene.parts?.['right ball'];
    this.balls =
      diagram === 'collision' && sim.scene.label === 'Collision' && left?.body && right?.body
        ? { bodies: [left.body, right.body], kg: [left.kg ?? DEFAULT_KG, right.kg ?? DEFAULT_KG] }
        : null;
    this.mSamples = [];
    this.pMax = this.keMax = 0;
    this.legend.innerHTML = this.balls ? MOMENTUM_LEGEND : this.lever ? TORQUE_LEGEND : ENERGY_LEGEND;
    this.root.classList.toggle('lg-momentum', !!this.balls);
    this.metricLabel.textContent = this.balls ? 'Momentum' : this.lever ? 'Torque balance' : this.measuresPeriod() ? 'Period' : 'Speed';
    this.metricValue.textContent = '--';
    this.metricValue.classList.remove('lg-long');
    // If Moon mode was on for the previous drawing, keep it on for the new one.
    if (this.moon.checked) sim.setParams({ gravity: MOON_G });
    this.syncGravity();
    this.showTheory();
    sim.stepListeners.push((engine) => this.onStep(sim, engine));
  }

  /**
   * The textbook period next to the measured one: pendulum 2π√(L/g) with the drawn string length, corrected for
   * the swing's amplitude θ₀ (shown in the label), spring 2π√(m/k) with the simulated k. Follows gravity changes
   * (slider, Moon mode). Switching gravity mid-swing changes the amplitude (the bob keeps its speed): switched at
   * the bottom, a 21° Earth swing becomes a 53° Moon swing, 5.7 % slower than 2π√(L/g), so θ₀ is part of the theory.
   */
  private showTheory() {
    const sim = this.sim;
    if (this.balls) return; // the kinetic energy line is written every step (onStep)
    let text = '';
    if (sim && this.diagram === 'pendulum' && sim.scene.label === 'Pendulum' && sim.scene.measures?.string) {
      const L = meters(sim.scene.measures.string, this.scale);
      const g = sim.gravity;
      const amp = swingAmplitude(sim, sim.engine.gravity.scale);
      const T = g > 0 && amp !== null ? (2 * Math.PI * Math.sqrt(L / g)) * amplitudeFactor(amp) : 0;
      text = amp === null || !(T > 0) ? 'Theory 2π√(L/g) = --' : `Theory (θ₀=${Math.round((amp * 180) / Math.PI)}°) = ${formatSeconds(T)}`;
    } else if (sim && this.diagram === 'spring' && sim.scene.label === 'Spring and mass') {
      const k = sim.scene.physics?.springK?.value;
      const block = sim.scene.parts?.block;
      if (k && block) {
        const m = block.kg ?? DEFAULT_KG;
        text = `Theory 2π√(m/k) = ${formatSeconds(2 * Math.PI * Math.sqrt(m / k))}`;
      }
    } else if (sim && sim.scene.label === 'Incline' && sim.scene.physics?.rolling) {
      // A ball rolls down at 5/7 g sinθ (solid ball), or slides while turning when friction cannot hold it.
      const roll = sim.scene.physics.rolling;
      const theta = ((sim.scene.physics.rampAngleUsed?.value ?? 0) * Math.PI) / 180;
      const mu = Number((roll.body.plugin as { inclineMu?: number }).inclineMu ?? DEFAULT_FRICTION);
      const t = rollAccel(sim.gravity, theta, mu, roll.inertia);
      const m = roll.measured();
      // px per step² -> m/s².
      const measured = m === null ? '--' : formatAccel(meters(m, this.scale) / (STEP_S * this.scale.timeFactor) ** 2);
      text = `${t.rolls ? 'Rolls: a = 5/7 g sinθ' : 'Slides: g(sinθ − μcosθ)'} = ${formatAccel(t.a)}\nmeasured ${measured}`;
    }
    if (this.theoryLabel.textContent !== text) this.theoryLabel.textContent = text;
    this.theoryLabel.hidden = !text;
  }

  /** True when the theory line follows the motion and is redrawn every step. */
  private liveTheory() {
    return this.diagram === 'pendulum' || !!this.sim?.scene.physics?.rolling;
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
    // a provisional estimate: a pendulum's period goes as 1/sqrt(g) times the amplitude factor (the swing
    // grows or shrinks with the switch, see showTheory); a spring's does not depend on g.
    if (changed && this.measuresPeriod()) {
      const old = this.period.value();
      let ratio = 1;
      if (this.diagram === 'pendulum' && this.sim) {
        const a0 = swingAmplitude(this.sim, (BASE_SCALE * oldG) / EARTH_G);
        const a1 = swingAmplitude(this.sim, this.sim.engine.gravity.scale);
        ratio = Math.sqrt(oldG / g) * (a0 !== null && a1 !== null ? amplitudeFactor(a1) / amplitudeFactor(a0) : 1);
      }
      const guess = old && Number.isFinite(ratio) ? old.period * ratio : null;
      this.period.restart(guess);
      this.showPeriod();
    }
  }

  /** Measured period, converted from screen seconds to physical seconds. */
  private showPeriod() {
    const p = this.period.value();
    const T = p ? physSeconds(p.period, this.scale) : 0;
    setText(this.metricValue, !p ? '--' : p.provisional ? `~${T.toFixed(T < 1 ? 2 : 1)} s` : formatSeconds(T));
  }

  private onStep(sim: Simulation, engine: Matter.Engine) {
    if (this.sim !== sim) return; // a newer drawing has replaced this one
    this.time += STEP_S;
    this.syncGravity();
    const g = sim.gravity;
    if (this.lever) {
      this.showTorque(this.lever, g);
      return;
    }
    const bodies = Matter.Composite.allBodies(engine.world).filter((b) => !b.isStatic);

    if (this.balls) {
      // Momentum m·v along the floor (right = +) of each ball, in kg·m/s, and the kinetic energy of both.
      const [b1, b2] = this.balls.bodies, [m1, m2] = this.balls.kg;
      const v1 = mps(b1.velocity.x, this.scale), v2 = mps(b2.velocity.x, this.scale);
      const s = { p1: m1 * v1, p2: m2 * v2, ke: 0.5 * m1 * v1 * v1 + 0.5 * m2 * v2 * v2 };
      this.mSamples.push(s);
      if (this.mSamples.length > MAX_SAMPLES) this.mSamples.shift();
      setText(this.metricValue, formatMomentum(s.p1 + s.p2));
      setText(this.theoryLabel, `Kinetic energy ${formatEnergy(s.ke)}`);
      this.theoryLabel.hidden = false;
      this.drawMomentum();
      return;
    }

    // Joules: written or assumed (1 kg) masses, speeds and heights in metres through the scene's scale.
    let ke = 0;
    let pe = 0;
    const ref = this.peRef;
    const roll = sim.scene.physics?.rolling;
    for (const b of bodies) {
      const kg = this.kg.get(b) ?? DEFAULT_KG;
      const v = mps(Math.hypot(b.velocity.x, b.velocity.y), this.scale);
      ke += 0.5 * kg * v * v;
      // A rolling ball also carries ½ I ω² = ½ (I/(m r²)) m (r ω)² in its spin (angularVelocity is rad per step).
      if (roll && b === roll.body) ke += 0.5 * roll.inertia * kg * mps(roll.radius * Math.abs(b.angularVelocity), this.scale) ** 2;
      if (ref.kind === 'spring') continue; // gravity is inside ½ k d² below
      // Height above the bottom of the swing (pendulum) or the bottom edge (window: offset when drawing).
      const baseY = ref.kind === 'pendulum' ? ref.bottomY : sim.worldH;
      pe += kg * g * Math.max(0, meters(baseY - b.position.y, this.scale));
    }
    pe += ref.kind === 'spring' ? springEnergyFromRest(sim, this.scale) : springEnergy(engine, this.scale, this.kg);
    this.samples.push({ ke, pe });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    if (this.measuresPeriod()) {
      const main = mainBody(bodies);
      if (main) this.period.push(this.time, main);
      this.showPeriod();
      // The pendulum's theory follows its amplitude (air drag slowly shrinks it).
      if (this.diagram === 'pendulum') this.showTheory();
    } else {
      // A rolling ball: the measured acceleration next to 5/7 g sinθ (and μ may change with the slider).
      if (this.liveTheory()) this.showTheory();
      // Same tracker, same body, same conversion and formatter as the velocity arrow's number.
      const f = sim.motion.fastest();
      setText(this.metricValue, f ? formatSpeed(mps(Math.hypot(f.track.vx, f.track.vy), this.scale)) : '--');
    }
    this.draw();
  }

  /** Ball collision: momentum (each ball and the total) on top, kinetic energy of both below, last 8 s. */
  private drawMomentum() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = 150;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const left = 22, right = cssW - 4;
    const w = right - left;
    // Momentum panel (zero in the middle: left-going is below) and energy panel, one time axis.
    const pTop = 6, pBottom = 88, eTop = 98, eBottom = cssH - 18;
    let peakP = 0, peakE = 0;
    for (const s of this.mSamples) {
      peakP = Math.max(peakP, Math.abs(s.p1), Math.abs(s.p2), Math.abs(s.p1 + s.p2));
      peakE = Math.max(peakE, s.ke);
    }
    // Jumps up at once, eases down slowly (as the energy graph).
    const ease = (cur: number, target: number) => (target > cur ? target : cur + (target - cur) * 0.01);
    this.pMax = ease(this.pMax, peakP * HEADROOM);
    this.keMax = ease(this.keMax, peakE * HEADROOM);
    const pMax = this.pMax > 1e-9 ? this.pMax : 1;
    const keMax = this.keMax > 1e-9 ? this.keMax : 1;
    const pMid = (pTop + pBottom) / 2;
    const yP = (p: number) => pMid - Math.max(-1, Math.min(1, p / pMax)) * ((pBottom - pTop) / 2);
    const yE = (e: number) => eBottom - Math.max(0, Math.min(1, e / keMax)) * (eBottom - eTop);

    ctx.lineCap = 'round';
    ctx.strokeStyle = '#eeeeee';
    ctx.lineWidth = 2;
    line(ctx, left, pTop, right, pTop);
    line(ctx, left, pBottom, right, pBottom);
    ctx.strokeStyle = '#e0e0e0';
    line(ctx, left, pTop, left, pBottom);
    line(ctx, left, eTop, left, eBottom);
    line(ctx, left, eBottom, right, eBottom);
    ctx.setLineDash([4, 4]);
    line(ctx, left, pMid, right, pMid);
    ctx.setLineDash([]);

    ctx.fillStyle = '#afafaf';
    ctx.font = '800 11px Nunito, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.fillText('now', right, cssH - 4);
    ctx.textAlign = 'left';
    const span = physSeconds(WINDOW_S, this.scale);
    ctx.fillText(`-${span < 10 ? span.toFixed(1) : span.toFixed(0)} s`, left, cssH - 4);
    ctx.font = '700 10px Nunito, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('p: right = +', (left + right) / 2, cssH - 4);
    ctx.font = '800 11px Nunito, system-ui, sans-serif';
    for (const [text, y] of [['p', pMid], ['KE', (eTop + eBottom) / 2]] as const) {
      ctx.save();
      ctx.translate(13, y);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }

    const n = this.mSamples.length;
    if (n >= 2) {
      const x0 = right - ((n - 1) / (MAX_SAMPLES - 1)) * w;
      const dx = w / (MAX_SAMPLES - 1);
      const plot = (color: string, f: (s: MomentumSample) => number, width = 3) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        this.mSamples.forEach((s, i) => (i ? ctx.lineTo(x0 + i * dx, f(s)) : ctx.moveTo(x0, f(s))));
        ctx.stroke();
      };
      plot(ORANGE, (s) => yP(s.p1));
      plot(BLUE, (s) => yP(s.p2));
      plot(GREEN, (s) => yP(s.p1 + s.p2), 3.5);
      plot(PURPLE, (s) => yE(s.ke));
    }
    // Scale of each panel, on a white halo.
    ctx.font = '800 11px Nunito, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#999';
    for (const [text, y] of [[`±${formatMomentum(pMax)}`, pTop + 2], [formatEnergy(keMax), eTop + 1]] as const) {
      ctx.strokeText(text, left + 6, y);
      ctx.fillText(text, left + 6, y);
    }
  }

  /**
   * Seesaw: the moment m·g·d of each side (N·m) as two bars, which side wins, and each side's m and d. Follows gravity
   * (slider, Moon mode): both moments scale with g, the winner does not change.
   */
  private showTorque(lever: LeverInfo, g: number) {
    const tau = (s: LeverSide | null) => (s ? s.kg * g * s.d : 0);
    const tl = tau(lever.left), tr = tau(lever.right);
    const verdict = lever.nearly ? 'Nearly balanced' : lever.balanced ? 'Balanced!' : tl > tr ? 'Left wins' : 'Right wins';
    if (this.metricValue.textContent !== verdict) this.metricValue.textContent = verdict;
    // "Nearly balanced" at full size runs into the Moon mode switch on a phone.
    this.metricValue.classList.toggle('lg-long', verdict.length > 12);
    const theory = `${formatTorque(tl)} ${lever.balanced ? '≈' : tl > tr ? '>' : '<'} ${formatTorque(tr)}`;
    if (this.theoryLabel.textContent !== theory) this.theoryLabel.textContent = theory;
    this.theoryLabel.hidden = false;

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
    const labelW = 46, valueW = 76;
    const x0 = labelW, x1 = cssW - valueW;
    const top = Math.max(tl, tr, 1e-9);
    const rows: [string, LeverSide | null, number][] = [['Left', lever.left, tl], ['Right', lever.right, tr]];
    rows.forEach(([name, side, t], k) => {
      const y = 10 + k * 56;
      const heavier = !lever.balanced && t === top;
      const color = lever.balanced ? GREEN : heavier ? ORANGE : BLUE;
      ctx.font = '800 13px Nunito, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#3c3c3c';
      ctx.fillText(name, 0, y + 11);
      // Track, then the bar (rounded), then the value.
      ctx.fillStyle = '#f0f0f0';
      roundRect(ctx, x0, y, x1 - x0, 22, 11);
      ctx.fill();
      const w = Math.max(t > 0 ? 22 : 0, ((x1 - x0) * t) / top);
      if (w > 0) {
        ctx.fillStyle = color;
        roundRect(ctx, x0, y, w, 22, 11);
        ctx.fill();
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = '#3c3c3c';
      ctx.fillText(formatTorque(t), cssW, y + 11);
      ctx.font = '700 11px Nunito, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#999';
      ctx.fillText(side ? `m = ${formatMass(side.kg)} · d = ${formatLength(side.d)}` : 'no weight', x0 + 2, y + 34);
    });
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
  if (diagram === 'spring' && scene.label === 'Spring and mass' && scene.physics?.springK) return { kind: 'spring' };
  return { kind: 'window' };
}

/**
 * Potential energy of a mass on a drawn spring measured from its rest position, in joules: ½ k d², with the k the
 * spring scene runs (scenes/spring-motion.ts) and d = how far the block is from where gravity and spring balance
 * right now. Gravity's share is inside this: m g h + ½ k x² is ½ k d² plus a constant. The scene's motion keeps
 * ½ m v² + ½ k d² exactly, so the Total stays flat.
 */
function springEnergyFromRest(sim: Simulation, scale: Scale): number {
  const spring = sim.scene.physics?.springK;
  if (!spring) return 0;
  const d = meters(spring.stretch(), scale);
  return 0.5 * spring.value * d * d;
}

/**
 * Amplitude θ₀ (radians) of the pendulum's swing right now, from its energy: the bob's height and speed give the
 * angle where it would stop, cos θ₀ = cos θ − v² / (2 g L), under the engine gravity `gravityScale` (Matter's
 * gravity.scale; pass an old one to get the amplitude the swing had before a gravity change). Null when the scene
 * is not the pendulum, gravity is off, or the bob goes over the top.
 */
export function swingAmplitude(sim: Simulation, gravityScale: number): number | null {
  const swing = sim.scene.sprites.find((s) => s.follow.kind === 'swing')?.follow;
  if (swing?.kind !== 'swing') return null;
  const gv = sim.engine.gravity;
  const gn = Math.hypot(gv.x, gv.y);
  // Gravity in px per step², as the pendulum integrates it.
  const G = gn * gravityScale * STEP_MS * STEP_MS;
  if (!(G > 0)) return null;
  const b = swing.body;
  const dx = b.position.x - swing.pivot.x, dy = b.position.y - swing.pivot.y;
  const L = Math.hypot(dx, dy);
  if (!(L > 0)) return null;
  // Angle from "straight down" along gravity.
  const cos = (dx * gv.x + dy * gv.y) / (L * gn);
  const v2 = b.velocity.x ** 2 + b.velocity.y ** 2;
  const c0 = cos - v2 / (2 * G * L);
  return c0 < -1 ? null : Math.acos(Math.min(1, c0));
}

/**
 * Exact period of a pendulum swinging to ±θ₀ over the small-swing 2π√(L/g): 1 / AGM(1, cos(θ₀/2)).
 * 20° gives ×1.0077 (≈ 1 + θ₀²/16), 53° gives ×1.057.
 */
export function amplitudeFactor(theta0: number): number {
  let a = 1, b = Math.cos(theta0 / 2);
  if (!(b > 0)) return Infinity;
  for (let i = 0; i < 30 && Math.abs(a - b) > 1e-15; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return 1 / a;
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

const formatAccel = (a: number) => `${a.toFixed(2)} m/s²`;
/** Moment in newton metres, as many digits as the energies. */
const formatTorque = (v: number) => `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} N·m`;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Text written every physics step: only touched when it changes, so an unchanged readout does not make the browser
 * redo style, layout and paint of the card on every frame.
 */
function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
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
  .lg-momentum .lg-metric-value { font-size: 24px; }
  .lg-metric-value.lg-long { font-size: 22px; line-height: 1.5; }
  .lg-metric-value { font-size: 30px; font-weight: 900; color: #3c3c3c; line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .lg-moon { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; flex-shrink: 0; }
  .lg-moon input { position: absolute; opacity: 0; pointer-events: none; }
  .lg-moon-text { display: flex; flex-direction: column; align-items: flex-end; font-weight: 800; font-size: 15px; color: #3c3c3c; }
  .lg-g { font-size: 12px; font-weight: 700; color: #777; }
  .lg-theory { margin-top: 2px; font-size: 12px; font-weight: 800; color: #1899d6; font-variant-numeric: tabular-nums; white-space: pre-line; }
  .lg-theory[hidden] { display: none; }
  .lg-switch { position: relative; width: 52px; height: 30px; border-radius: 999px; background: #e5e5e5; transition: background 0.2s; flex-shrink: 0; }
  .lg-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 2px 0 rgba(0,0,0,0.12); transition: transform 0.2s; }
  .lg-moon input:checked + .lg-switch { background: #1cb0f6; }
  .lg-moon input:checked + .lg-switch::after { transform: translateX(22px); }
  .lg-moon input:focus-visible + .lg-switch { outline: 3px solid #84d8ff; outline-offset: 2px; }
  .lg-canvas { display: block; width: 100%; height: 120px; }
  .lg-legend { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; font-size: 13px; font-weight: 800; color: #777; }
  .lg-legend[hidden] { display: none; }
  .lg-legend i { display: inline-block; width: 12px; height: 4px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}
