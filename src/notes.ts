// Values on the drawing: a small card next to each part with its physical value and, underneath, where that
// value came from ("L = 0.42 m / assumed", "m = 2 kg / you entered"), plus the slow-motion badge on the picture.
// Everything is read from the scene (measures, parts, physics) and converted by units.ts.
//
// Where a card goes: next to its part, but off the way of everything that moves. When the scene starts, the
// path of every moving body is worked out from the scene's own physics (the pendulum's arc, the pulley weights'
// run up and down, the projectile's arc, the spring's stroke, the slide down a ramp), together with the velocity
// arrow it will carry along that path (as long as the arrows will draw it, see vectors.ts). A card is placed
// clear of all of that, of the other cards and of the scale bar's corner, then stays put. It only moves when
// something still comes near (a path that went differently): every frame it is checked against the bodies and
// arrows as they are now.

import Matter from 'matter-js';
import { DEFAULT_FRICTION } from './scenes/incline';
import { visibleRect, type Simulation } from './sim';
import type { Analysis, BuiltScene, PartInfo, PartName, Point, ValueSource, ViewRect } from './types';
import {
  DEFAULT_KG,
  OMEGA2_PER_STIFFNESS,
  SOURCE_TEXT,
  STEP_MS,
  formatLength,
  formatMass,
  formatSpeed,
  formatSpringK,
  meters,
  noteFor,
  scaleOf,
  springK,
  timeLabel,
} from './units';
import { ARROW_HEAD_HALF_CSS, LABEL_SPACE_CSS, LMAX_FRACTION, scaleBarZone } from './vectors';

const C = { green: '#58cc02', blue: '#1cb0f6', orange: '#ff9600', red: '#ff4b4b', purple: '#ce82ff' };
const PART_COLOR: Record<PartName, string> = {
  string: C.blue,
  bob: C.orange,
  spring: C.purple,
  block: C.orange,
  ramp: C.green,
  ground: C.green,
  ball: C.orange,
  arrow: C.red,
  'left weight': C.orange,
  'right weight': C.orange,
  wheel: C.purple,
  'left ball': C.orange,
  'right ball': C.blue,
};

/** Sizes in CSS px (converted to world px every frame, like the velocity arrows). Two lines: value, then source. */
const FONT_CSS = 11.5;
const SRC_FONT_CSS = 9.5;
const PILL_H_CSS = 31;
const PAD_CSS = 8;
const RADIUS_CSS = 11;
/** Between the cards of one part; between different parts' cards and the scale bar it is LABEL_SPACE_CSS. */
const GAP_CSS = 6;
/** Room a card keeps from an arrow's edge (CSS px). */
const ARROW_SPACE_CSS = 6;
/** Thickness kept clear around a swinging string (CSS px, from its centre line). */
const STRING_HALF_CSS = 3;
/** Spacing of the predicted path samples (world px along the path). */
const PATH_STEP = 6;
/** Most observed path samples kept (oldest dropped first). */
const OBSERVED_MAX = 1500;
/** After a search that found no clean spot, frames until the next one. */
const RETRY_FRAMES = 15;
/** Buttons starting this close to the picture's top edge (CSS px) form the top row kept clear across the width. */
const TOP_ROW_CSS = 40;

interface Pill {
  part: PartName;
  /** e.g. "L = 0.42 m"; re-read every frame (μ follows the slider). */
  value: () => string;
  /** e.g. "assumed". */
  from: () => string;
}

/** The labels of one part, drawn as one block next to it (two cards per row). */
interface Group {
  part: PartName;
  pills: Pill[];
  /** Index into the candidate spots of the last placement (for tests). */
  spot: number;
  /** Where the block sits (world px centre); kept while it stays clear. */
  at: Point | null;
  /** Frames left before looking again for a clean spot, after a search that found none. */
  retry: number;
}

export type Box = { x: number; y: number; w: number; h: number };

/**
 * Something a card keeps off: a box (a body), or a line `r` CSS px thick each side of its centre line (an
 * arrow, a string). `soft` ones (strings) are given up first when nothing else fits.
 */
type Keep = ({ box: Box } | { seg: [number, number, number, number]; r: number }) & { soft?: boolean };

export class QuantityLabels {
  enabled = true;
  private sim: Simulation | null = null;
  private groups: Group[] = [];
  private badge: HTMLDivElement;
  /** Label boxes of the last frame (world px), so the velocity arrows can keep their numbers off them. */
  boxes: Box[] = [];
  /** Predicted paths of the moving bodies and their arrows (world px), worked out on the first frame. */
  private paths: Keep[] | null = null;
  /** Where bodies and arrows actually went (added as they move, for any later re-placement). */
  private observed: Keep[] = [];
  private lastSeen = new Map<Matter.Body, Point>();
  /** Fastest body speed seen, px per step (scales the arrows of a scene without a speedHint). */
  private vSeen = 0;
  /** Buttons and badges floating over the picture (the slow-motion badge, "Show what AI saw"), world px. */
  private floats: { boxes: Box[]; css: number; x0: number; y0: number; age: number } | null = null;

  constructor(private card: HTMLElement) {
    injectStyle();
    this.badge = document.createElement('div');
    this.badge.className = 'time-badge';
    this.badge.hidden = true;
    card.appendChild(this.badge);
  }

  /** New photo: hide until its simulation starts. */
  reset() {
    this.sim = null;
    this.groups = [];
    this.boxes = [];
    this.badge.hidden = true;
  }

  attach(sim: Simulation, analysis: Analysis) {
    this.sim = sim;
    const scale = scaleOf(sim.scene);
    this.groups = [];
    this.boxes = [];
    this.paths = null;
    this.observed = [];
    this.lastSeen.clear();
    this.vSeen = 0;
    for (const pill of pillsFor(sim.scene, analysis)) {
      const g = this.groups.find((x) => x.part === pill.part);
      if (g) g.pills.push(pill);
      else this.groups.push({ part: pill.part, pills: [pill], spot: 0, at: null, retry: 0 });
    }
    this.badge.textContent = timeLabel(scale);
    this.badge.title = `1 s on screen = ${Number(scale.timeFactor.toPrecision(2))} s of real time`;
    this.badge.hidden = false;
    sim.drawListeners.push((ctx, scene, s) => {
      if (this.sim === sim && this.enabled) this.draw(ctx, scene, s);
    });
  }

  /** Labels drawn in the last frame (for tests): text, centre in world px, index of the spot used. */
  last: { text: string; x: number; y: number; spot: number }[] = [];

  private draw(ctx: CanvasRenderingContext2D, scene: BuiltScene, pxScale: number) {
    const css = (window.devicePixelRatio || 1) / pxScale; // world px per CSS px
    // What the picture shows (world px): the photo, or the scene's view (sim.ts).
    const vis = visibleRect(ctx);
    const worldW = vis.w;
    const worldH = vis.h;
    const h = PILL_H_CSS * css;
    const gap = GAP_CSS * css;
    const pad = PAD_CSS * css;
    const font = `800 ${FONT_CSS * css}px Nunito, "Avenir Next", system-ui, sans-serif`;
    const srcFont = `700 ${SRC_FONT_CSS * css}px Nunito, "Avenir Next", system-ui, sans-serif`;
    const placed: Box[] = [];
    const space = LABEL_SPACE_CSS * css;
    const lmax = LMAX_FRACTION * Math.min(worldW, worldH);
    if (!this.groups.length) {
      this.last = [];
      this.boxes = [];
      return;
    }
    const sim = this.sim!;
    const predicted = (this.paths ??= predictPaths(scene, sim.engine, vis, lmax));
    // What moves right now (bodies, their arrows, swinging strings); also remembered for later re-placements.
    const now = this.current(scene, lmax);
    // Labels never cover a part of the drawing (its own or another one's): moving parts by their body's box,
    // fixed ones (wheel, launch point) by their clearance circle. Nor the scale bar's corner.
    const m = 2 * css;
    const keepBoxes: Box[] = [];
    const keepCircles: { c: Point; r: number }[] = [];
    for (const p of Object.values(scene.parts ?? {})) {
      if (!p) continue;
      if (p.body) {
        const b = p.body.bounds;
        keepBoxes.push({ x: b.min.x - m, y: b.min.y - m, w: b.max.x - b.min.x + 2 * m, h: b.max.y - b.min.y + 2 * m });
      } else if ((p.clear ?? 0) > 0) keepCircles.push({ c: { ...p.at() }, r: p.clear! });
    }
    const bar = scaleBarZone(ctx, css, worldW, worldH, vis.x, vis.y);
    const floats = this.floatingBoxes(ctx.canvas, css, vis);
    const arrowGap = ARROW_SPACE_CSS * css;
    /** Is a box clear of the given things (bodies 2 px apart, arrows and strings ARROW_SPACE_CSS from their edge)? */
    const clearOf = (b: Box, list: Keep[], soft: boolean) =>
      !list.some((k) => (soft || !k.soft) && ('box' in k ? overlap(grow(k.box, m), b) : segBoxDist(k.seg, b) < k.r * css + arrowGap));
    this.last = [];
    for (const group of this.groups) {
      const part = scene.parts?.[group.part];
      if (!part) continue;
      const rows = group.pills.map((pill) => ({ value: pill.value(), from: pill.from() }));
      let cw = 0;
      for (const r of rows) {
        ctx.font = font;
        cw = Math.max(cw, ctx.measureText(r.value).width);
        ctx.font = srcFont;
        cw = Math.max(cw, ctx.measureText(r.from).width);
      }
      cw += 2 * pad;
      // The part's labels as one block placed as a unit: same-width cards, two per row.
      const cols = Math.min(2, rows.length);
      const nRows = Math.ceil(rows.length / cols);
      const w = cols * cw + (cols - 1) * gap;
      const H = nRows * h + (nRows - 1) * gap;
      const boxAt = (c: Point): Box => ({ x: c.x - w / 2, y: c.y - H / 2, w, h: H });
      /** On the picture, LABEL_SPACE_CSS off the other cards, the scale bar and the buttons over the picture. */
      const fixedOk = (b: Box) =>
        b.x >= vis.x + 2 * css &&
        b.y >= vis.y + 2 * css &&
        b.x + b.w <= vis.x + worldW - 2 * css &&
        b.y + b.h <= vis.y + worldH - 2 * css &&
        !placed.some((o) => overlap(grow(o, space), b)) &&
        !overlap(grow(bar, space), b) &&
        !floats.some((o) => overlap(grow(o, space), b));
      // Always: that, off the drawing's parts, and off whatever moves right now (bodies and their arrows).
      const base = (b: Box) =>
        fixedOk(b) &&
        !keepBoxes.some((o) => overlap(o, b)) &&
        !keepCircles.some((k) => boxCircleOverlap(b, k.c, k.r)) &&
        clearOf(b, now, false);
      // The block stays where it was put while that is still fine (a card that follows a moving part would
      // ride on its path); otherwise it is placed again, at most every few frames when nothing fits.
      if (!group.at || (!base(boxAt(group.at)) && --group.retry <= 0)) {
        const spots = spotsFor(part, w, H, gap);
        const paths = this.observed.length ? predicted.concat(this.observed) : predicted;
        // Best: off every path, strings included; then strings may be crossed; then off what moves right now only.
        const tiers = [(b: Box) => clearOf(b, paths, true), (b: Box) => clearOf(b, paths, false), () => true];
        /** A spot moved just enough to keep its card on the picture (3 px in, so it passes the 2 px edge test). */
        const inside = (s: Point): Point => ({
          x: Math.min(Math.max(s.x, vis.x + w / 2 + 3 * css), vis.x + worldW - w / 2 - 3 * css),
          y: Math.min(Math.max(s.y, vis.y + H / 2 + 3 * css), vis.y + worldH - H / 2 - 3 * css),
        });
        const find = (list: Point[]) => {
          for (const ok of tiers) {
            const i = list.findIndex((s) => {
              const b = boxAt(s);
              return base(b) && ok(b);
            });
            if (i >= 0) return i;
          }
          return -1;
        };
        let k = find(spots);
        if (k >= 0) {
          group.at = spots[k];
          group.retry = 0;
        } else {
          // A part in a corner of the picture (a launch point on a zoomed-out view): its spots pushed onto the picture.
          const pushed = spots.map(inside);
          k = find(pushed);
          if (k >= 0) {
            group.at = pushed[k];
            group.retry = 0;
          } else {
            // Nothing fits cleanly: the first spot that is at least off the buttons and the other cards (else the
            // preferred one), kept on the picture; look again in a moment.
            k = Math.max(0, pushed.findIndex((s) => fixedOk(boxAt(s))));
            group.at = pushed[k];
            group.retry = RETRY_FRAMES;
          }
        }
        group.spot = k;
      }
      const c = group.at;
      const k = group.spot;
      placed.push(boxAt(c));
      rows.forEach((r, i) => {
        const row = Math.floor(i / cols), col = i % cols;
        // A last row with a single card is centred.
        const inRow = Math.min(cols, rows.length - row * cols);
        const rowW = inRow * cw + (inRow - 1) * gap;
        const at = { x: c.x - rowW / 2 + cw / 2 + col * (cw + gap), y: c.y - H / 2 + h / 2 + row * (h + gap) };
        drawPill(ctx, at, cw, h, css, r.value, r.from, font, srcFont, PART_COLOR[group.part]);
        this.last.push({ text: `${r.value} (${r.from})`, x: at.x, y: at.y, spot: k });
      });
    }
    this.boxes = placed;
  }

  /**
   * Where the badges and buttons floating over the picture are (world px), so no card hides behind them.
   * Read from the page every half second or when the picture is resized (they show and hide on their own).
   */
  private floatingBoxes(canvas: HTMLCanvasElement, css: number, vis: ViewRect): Box[] {
    const f = this.floats;
    if (f && f.css === css && f.x0 === vis.x && f.y0 === vis.y && ++f.age < 30) return f.boxes;
    const cr = canvas.getBoundingClientRect();
    const boxes: Box[] = [];
    for (const el of this.card.querySelectorAll<HTMLElement>('.time-badge, .btn-float')) {
      if (el.hidden || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      boxes.push({ x: vis.x + (r.left - cr.left) * css, y: vis.y + (r.top - cr.top) * css, w: r.width * css, h: r.height * css });
    }
    // The row of buttons along the top edge is kept clear across the whole width (also the gap between them, and the
    // spot of a button that shows up a moment later), so no card sits half behind one.
    const top = boxes.filter((b) => b.y - vis.y < TOP_ROW_CSS * css);
    if (top.length) {
      const y0 = Math.min(...top.map((b) => b.y)), y1 = Math.max(...top.map((b) => b.y + b.h));
      boxes.push({ x: vis.x, y: y0, w: vis.w, h: y1 - y0 });
    }
    this.floats = { boxes, css, x0: vis.x, y0: vis.y, age: 0 };
    return boxes;
  }

  /**
   * What moves right now: each moving body's box, its velocity arrow (never shorter than the one vectors.ts
   * draws: that one is speed × Lmax / vRef with vRef ≥ speedHint) and a swinging string. Remembered as the
   * observed path every PATH_STEP world px.
   */
  private current(scene: BuiltScene, lmax: number): Keep[] {
    const out: Keep[] = [];
    const hint = scene.speedHint && scene.speedHint > 0 ? scene.speedHint : 0;
    for (const { body: b, pivot } of movingOf(scene)) {
      const v = Math.hypot(b.velocity.x, b.velocity.y);
      this.vSeen = Math.max(this.vSeen, v);
      const p = b.position;
      const keep = poseKeeps(b, p.x, p.y, v > 1e-9 ? [{ x: b.velocity.x / v, y: b.velocity.y / v }] : [], arrowLen(v, hint || this.vSeen, lmax), pivot);
      out.push(...keep);
      const last = this.lastSeen.get(b);
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= PATH_STEP) {
        this.lastSeen.set(b, { x: p.x, y: p.y });
        this.observed.push(...keep);
        if (this.observed.length > OBSERVED_MAX) this.observed.splice(0, this.observed.length - OBSERVED_MAX);
      }
    }
    return out;
  }
}

/** The bodies the user sees moving (as vectors.ts picks them), with the pivot of a swinging one. */
function movingOf(scene: BuiltScene): { body: Matter.Body; pivot?: Point }[] {
  const out: { body: Matter.Body; pivot?: Point }[] = [];
  for (const sp of scene.sprites) {
    const f = sp.follow;
    if (f.kind === 'stretch' || f.body.isStatic || out.some((o) => o.body === f.body)) continue;
    out.push({ body: f.body, pivot: f.kind === 'swing' ? f.pivot : undefined });
  }
  return out;
}

/** Arrow length (world px) at speed v when the arrows are scaled to vTop (both px per step), at most Lmax. */
const arrowLen = (v: number, vTop: number, lmax: number) => (v > 1e-9 ? Math.min(lmax, (v * lmax) / Math.max(vTop, 1e-9)) : 0);

/** What a body at (x, y) takes: its box, its arrow(s) of length `len` along `dirs`, and its string to `pivot`. */
function poseKeeps(b: Matter.Body, x: number, y: number, dirs: Point[], len: number, pivot?: Point): Keep[] {
  const hw = (b.bounds.max.x - b.bounds.min.x) / 2, hh = (b.bounds.max.y - b.bounds.min.y) / 2;
  const out: Keep[] = [{ box: { x: x - hw, y: y - hh, w: 2 * hw, h: 2 * hh } }];
  if (len > 0.5) for (const d of dirs) out.push({ seg: [x, y, x + d.x * len, y + d.y * len], r: ARROW_HEAD_HALF_CSS });
  if (pivot) out.push({ seg: [pivot.x, pivot.y, x, y], r: STRING_HALF_CSS, soft: true });
  return out;
}

/**
 * Where every moving body will go, and its arrow along the way, from the scene's own physics at the start:
 *   swinging (pendulum)  the arc between the turning points (energy), arrows both ways along it;
 *   pulley               straight up to the wheel and down to the bottom edge, full-length arrows both ways;
 *   projectile           the parabola until it reaches the ground (or leaves the picture);
 *   spring               the stroke of ± amplitude (speedHint / ω) along the spring;
 *   collision            the whole floor at the ball's height (it bounces between the walls), arrows both ways;
 *   anything else        straight on along its velocity, then along the ground (a block sliding off a ramp).
 */
function predictPaths(scene: BuiltScene, engine: Matter.Engine, vis: ViewRect, lmax: number): Keep[] {
  const out: Keep[] = [];
  // Edges of the picture (world px): left/top X0/Y0, right/bottom W/H (the photo: 0, 0, width, height).
  const X0 = vis.x, Y0 = vis.y, W = vis.x + vis.w, H = vis.y + vis.h;
  const g = engine.gravity.y * engine.gravity.scale * STEP_MS * STEP_MS; // px per step², downwards
  const hint = scene.speedHint && scene.speedHint > 0 ? scene.speedHint : 0;
  const groundY = scene.parts?.ground?.at().y;
  for (const { body: b, pivot } of movingOf(scene)) {
    const p = { ...b.position };
    const v0 = { ...b.velocity };
    const v = Math.hypot(v0.x, v0.y);
    const hh = (b.bounds.max.y - b.bounds.min.y) / 2;
    const add = (x: number, y: number, dirs: Point[], len: number) => out.push(...poseKeeps(b, x, y, dirs, len, pivot));

    if (pivot) {
      const L = Math.hypot(p.x - pivot.x, p.y - pivot.y);
      if (L < 1) continue;
      const th = Math.atan2(p.x - pivot.x, p.y - pivot.y);
      // Turning point from energy: v² = 2gL(cos φ − cos φmax). No gravity or over the top: the whole circle.
      const cosMax = g > 0 ? Math.cos(th) - (v * v) / (2 * g * L) : -2;
      const thMax = cosMax <= -1 ? Math.PI : Math.acos(Math.min(1, cosMax));
      const speedAt = (phi: number) => Math.sqrt(Math.max(0, v * v + 2 * g * L * (Math.cos(phi) - Math.cos(th))));
      const vTop = Math.max(hint, speedAt(0));
      const n = Math.min(240, Math.max(2, Math.ceil((2 * thMax * L) / PATH_STEP)));
      for (let i = 0; i <= n; i++) {
        const phi = -thMax + (2 * thMax * i) / n;
        const t = { x: Math.cos(phi), y: -Math.sin(phi) };
        add(pivot.x + L * Math.sin(phi), pivot.y + L * Math.cos(phi), [t, { x: -t.x, y: -t.y }], arrowLen(speedAt(phi), vTop, lmax));
      }
    } else if (scene.label === 'Pulley') {
      const wheel = scene.parts?.wheel;
      const top = wheel ? wheel.at().y + (wheel.clear ?? 0) + hh : p.y - vis.h / 2;
      for (let y = Math.min(top, p.y); y <= Math.max(H, p.y); y += PATH_STEP) add(p.x, y, [{ x: 0, y: -1 }, { x: 0, y: 1 }], lmax);
    } else if (scene.label === 'Collision') {
      for (let x = X0; x <= W; x += PATH_STEP) add(x, p.y, [{ x: 1, y: 0 }, { x: -1, y: 0 }], lmax);
    } else if (scene.label === 'Seesaw' && scene.physics?.lever) {
      // Turning with the plank about the pivot, from one floor stop to the other; arrows both ways along the arc.
      const { pivot: c, thetaMin, thetaMax, theta } = scene.physics.lever;
      const th0 = theta();
      const dx = p.x - c.x, dy = p.y - c.y;
      const r = Math.hypot(dx, dy);
      const a0 = Math.atan2(dy, dx) - th0;
      const n = Math.min(120, Math.max(2, Math.ceil(((thetaMax - thetaMin) * r) / PATH_STEP)));
      for (let i = 0; i <= n; i++) {
        const a = a0 + thetaMin + ((thetaMax - thetaMin) * i) / n;
        const t = { x: -Math.sin(a), y: Math.cos(a) };
        add(c.x + r * Math.cos(a), c.y + r * Math.sin(a), [t, { x: -t.x, y: -t.y }], lmax);
      }
    } else if (scene.label === 'Projectile') {
      const floor = groundY ?? H;
      const pts: { x: number; y: number; vx: number; vy: number }[] = [];
      let x = p.x, y = p.y, vx = v0.x, vy = v0.y, run = PATH_STEP;
      for (let i = 0; i < 3000; i++) {
        if (run >= PATH_STEP) {
          pts.push({ x, y, vx, vy });
          run = 0;
        }
        vy += g;
        x += vx;
        y += vy;
        run += Math.hypot(vx, vy);
        if (y + hh > floor || x < X0 - hh || x > W + hh || y > H + hh) break;
      }
      pts.push({ x, y, vx, vy });
      const vTop = Math.max(hint, ...pts.map((q) => Math.hypot(q.vx, q.vy)));
      for (const q of pts) {
        const s = Math.hypot(q.vx, q.vy);
        add(q.x, q.y, s > 1e-9 ? [{ x: q.vx / s, y: q.vy / s }] : [], arrowLen(s, vTop, lmax));
      }
    } else {
      const spring = scene.constraints.find((c) => c.bodyB === b && !c.bodyA);
      if (spring && v > 1e-9) {
        // Stroke ± amplitude along the kick (= along the spring); arrows both ways, longest in the middle.
        const omega = Math.sqrt(OMEGA2_PER_STIFFNESS * spring.stiffness);
        const vTop = Math.max(hint, v);
        const amp = (1.15 * vTop) / Math.max(omega, 1e-6);
        const d = { x: v0.x / v, y: v0.y / v };
        const n = Math.min(200, Math.max(2, Math.ceil((2 * amp) / PATH_STEP)));
        for (let i = 0; i <= n; i++) {
          const s = -amp + (2 * amp * i) / n;
          add(p.x + d.x * s, p.y + d.y * s, [d, { x: -d.x, y: -d.y }], lmax * Math.sqrt(Math.max(0, 1 - (s / amp) ** 2)));
        }
        continue;
      }
      // Straight on along the velocity (down if still), full-length arrow; along the ground once it gets there.
      let d = v > 1e-9 ? { x: v0.x / v, y: v0.y / v } : { x: 0, y: 1 };
      let x = p.x, y = p.y;
      for (let i = 0; i < 2000 && x >= X0 - hh && x <= W + hh && y <= H + hh && y >= Y0 - hh; i++) {
        add(x, y, [d], lmax);
        if (groundY !== undefined && d.y > 0 && y + hh >= groundY) d = { x: Math.sign(d.x) || 1, y: 0 };
        x += d.x * PATH_STEP;
        y += d.y * PATH_STEP;
      }
    }
  }
  return out;
}

const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });

/** Shortest distance between a segment and a box (0 when they touch or cross). */
function segBoxDist([x1, y1, x2, y2]: [number, number, number, number], b: Box): number {
  // Crossing: Liang-Barsky clip.
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
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
  if (clip(-dx, x1 - b.x) && clip(dx, b.x + b.w - x1) && clip(-dy, y1 - b.y) && clip(dy, b.y + b.h - y1)) return 0;
  const toSeg = (px: number, py: number) => {
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
  };
  const toBox = (px: number, py: number) => Math.hypot(Math.max(b.x - px, 0, px - b.x - b.w), Math.max(b.y - py, 0, py - b.y - b.h));
  return Math.min(toSeg(b.x, b.y), toSeg(b.x + b.w, b.y), toSeg(b.x, b.y + b.h), toSeg(b.x + b.w, b.y + b.h), toBox(x1, y1), toBox(x2, y2));
}

type Side = NonNullable<PartInfo['side']>;
/** After the preferred side: below, the opposite side, above (a label beside its part reads as belonging to it). */
const SIDE_ORDER: Record<Side, Side[]> = {
  right: ['right', 'below', 'left', 'above'],
  left: ['left', 'below', 'right', 'above'],
  above: ['above', 'right', 'left', 'below'],
  below: ['below', 'right', 'left', 'above'],
  center: ['center', 'below', 'above', 'right', 'left'],
};

/**
 * Where a label column (w × h) may go around its part, preferred side first: beside the part (clear of it),
 * then the other sides, then a step further out.
 */
function spotsFor(part: PartInfo, w: number, h: number, gap: number): Point[] {
  const a = part.at();
  // Room to leave on each side: a moving part's current box (it may have turned), else its clearance radius.
  const r = part.clear ?? 0;
  const b = part.body?.bounds;
  const room = b
    ? { left: a.x - b.min.x, right: b.max.x - a.x, top: a.y - b.min.y, bottom: b.max.y - a.y }
    : { left: r, right: r, top: r, bottom: r };
  const at = (side: Side, extra: number): Point => {
    switch (side) {
      case 'center':
        return { x: a.x, y: a.y + extra };
      case 'left':
        return { x: a.x - room.left - gap - w / 2 - extra, y: a.y };
      case 'above':
        return { x: a.x, y: a.y - room.top - gap - h / 2 - extra };
      case 'below':
        return { x: a.x, y: a.y + room.bottom + gap + h / 2 + extra };
      default:
        return { x: a.x + room.right + gap + w / 2 + extra, y: a.y };
    }
  };
  const out: Point[] = [];
  const step = Math.min(h, 40 * (gap / GAP_CSS)) + gap;
  // Further steps out are for a part whose neighbourhood is on a path (a swinging bob, a launch point).
  for (const n of [0, 1, 2, 3, 4, 6, 8]) for (const s of SIDE_ORDER[part.side ?? 'right']) out.push(at(s, n * step));
  return out;
}

function boxCircleOverlap(b: Box, c: Point, r: number) {
  const dx = Math.max(b.x - c.x, 0, c.x - (b.x + b.w));
  const dy = Math.max(b.y - c.y, 0, c.y - (b.y + b.h));
  return dx * dx + dy * dy < r * r;
}

/** The labels for one scene: which values each diagram shows, and where each value came from. */
function pillsFor(scene: BuiltScene, analysis: Analysis): Pill[] {
  const s = scaleOf(scene);
  const out: Pill[] = [];
  const measures = scene.measures ?? {};
  const parts = scene.parts ?? {};
  const add = (part: PartName, value: () => string, from: () => string) => {
    if (parts[part]) out.push({ part, value, from });
  };
  const text = (src: ValueSource) => SOURCE_TEXT[src];
  // A length is "you entered" on the part that set the scale, "to scale" elsewhere, else from paper = 1 m.
  const length = (part: PartName, symbol = 'L') => {
    const px = measures[part];
    if (!px) return;
    const from: ValueSource = s.note ? (s.note.part === part ? 'input' : 'scaled') : 'assumed';
    add(part, () => `${symbol} = ${formatLength(meters(px, s))}`, () => text(from));
  };
  // Masses: always where they change the motion or energy story; elsewhere only when entered.
  const mass = (part: PartName, always: boolean) => {
    const p = parts[part];
    if (!p?.kg || (!always && p.kgFrom !== 'input')) return;
    const kg = p.kg;
    add(part, () => `m = ${formatMass(kg)}`, () => text(p.kgFrom ?? 'assumed'));
  };
  const notedLength = () => (s.note ? s.note.part : null);

  switch (scene.label) {
    case 'Pendulum':
      length('string');
      mass('bob', true);
      break;
    case 'Spring and mass': {
      const c = scene.constraints[0];
      const block = parts.block;
      const info = scene.physics?.springK;
      if (c && block) {
        const k = springK(c.stiffness, block.kg ?? DEFAULT_KG, s);
        add('spring', () => `k = ${formatSpringK(k)}`, () =>
          info?.from === 'adjusted' && info.note ? `adjusted from ${formatSpringK(info.note)}` : text(info?.from ?? 'assumed'),
        );
      }
      if (notedLength() === 'spring') length('spring');
      mass('block', true);
      break;
    }
    case 'Incline': {
      // The angle the ramp runs: as drawn, or the entered one (the drawing is stretched to it, see incline.ts).
      const used = scene.physics?.rampAngleUsed;
      const drawn = scene.physics?.rampAngle;
      const asked = noteFor(analysis, 'angle', ['ramp']);
      if (used) {
        const from = used.from === 'adjusted' && asked ? `most that fits (not ${Math.round(asked.value)}°)` : text(used.from);
        add('ramp', () => `θ = ${Math.round(used.value)}°`, () => from);
      } else if (drawn !== undefined) add('ramp', () => `θ = ${Math.round(drawn)}°`, () => text('drawn'));
      const block = parts.block?.body;
      if (block) {
        const mu = () => Number((block.plugin as { inclineMu?: number }).inclineMu ?? DEFAULT_FRICTION);
        add('ramp', () => `μ = ${mu().toFixed(2)}`, () => text(Math.abs(mu() - DEFAULT_FRICTION) < 1e-6 ? 'assumed' : 'slider'));
      }
      const n = notedLength();
      if (n === 'ramp' || n === 'ground') length(n);
      mass('block', false);
      break;
    }
    case 'Projectile': {
      const ls = scene.physics?.launchSpeed;
      if (ls) add('arrow', () => `v₀ = ${formatSpeed(ls.value)}`, () => text(ls.from));
      length('ground');
      mass('ball', false);
      break;
    }
    case 'Pulley':
      mass('left weight', true);
      mass('right weight', true);
      if (notedLength() === 'wheel') length('wheel', 'D');
      break;
    case 'Collision': {
      // Mass and starting speed of each ball (an arrow shows the direction), and the bounciness on the floor.
      const v = scene.physics?.ballSpeeds;
      for (const [part, side] of [['left ball', 'left'], ['right ball', 'right']] as const) {
        mass(part, true);
        const s0 = v?.[side];
        if (s0)
          add(part, () => `v₀ = ${Math.abs(s0.value) < 1e-9 ? '0 m/s' : `${s0.value < 0 ? '← ' : ''}${formatSpeed(Math.abs(s0.value))}${s0.value > 0 ? ' →' : ''}`}`, () => text(s0.from));
      }
      const e = () => Math.min(1, Math.max(0, Number(analysis.params.bounciness ?? 1)));
      add('ground', () => `e = ${e().toFixed(2)}`, () => (analysis.params.bounciness === undefined ? text('assumed') : text('slider')));
      break;
    }
    case 'Seesaw': {
      // Each weight: its mass and its distance d from the pivot (the moment is m·g·d, see the torque card).
      const lever = scene.physics?.lever;
      for (const [part, side] of [['left weight', lever?.left], ['right weight', lever?.right]] as const) {
        mass(part, true);
        if (!side || !measures[part]) continue;
        const from = side.dFrom === 'adjusted' ? 'most that fits' : text(side.dFrom);
        add(part, () => `d = ${formatLength(side.d)}`, () => from);
      }
      break;
    }
  }
  return out;
}

/** Rounded white card with a coloured border: the value on top, where it came from underneath. */
function drawPill(
  ctx: CanvasRenderingContext2D,
  c: Point,
  w: number,
  h: number,
  css: number,
  value: string,
  from: string,
  font: string,
  srcFont: string,
  color: string,
) {
  const x = c.x - w / 2, y = c.y - h / 2, r = Math.min(RADIUS_CSS * css, h / 2);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
  ctx.lineWidth = 2 * css;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.font = font;
  ctx.fillStyle = '#3c3c3c';
  ctx.fillText(value, c.x, c.y - 5.5 * css);
  ctx.font = srcFont;
  ctx.fillStyle = '#9a9a9a';
  ctx.fillText(from, c.x, c.y + 7 * css);
  ctx.restore();
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const css = `
  .time-badge {
    position: absolute; top: 10px; left: 10px; z-index: 2; pointer-events: none;
    font-size: 12px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: #1899d6;
    background: rgba(255, 255, 255, 0.94); border: 2px solid #e5e5e5; border-bottom-width: 3px; border-radius: 12px;
    padding: 6px 10px; white-space: nowrap;
  }
  .time-badge[hidden] { display: none; }
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}
