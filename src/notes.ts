// Values on the drawing: a small card next to each part with its physical value and, underneath, where that
// value came from ("L = 0.42 m / assumed", "m = 2 kg / your note"), plus the slow-motion badge on the picture.
// Everything is read from the scene (measures, parts, physics) and converted by units.ts.

import { DEFAULT_FRICTION } from './scenes/incline';
import type { Simulation } from './sim';
import type { Analysis, BuiltScene, PartInfo, PartName, Point, ValueSource } from './types';
import {
  DEFAULT_KG,
  SOURCE_TEXT,
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
};

/** Sizes in CSS px (converted to world px every frame, like the velocity arrows). Two lines: value, then source. */
const FONT_CSS = 11.5;
const SRC_FONT_CSS = 9.5;
const PILL_H_CSS = 31;
const PAD_CSS = 8;
const RADIUS_CSS = 11;
const GAP_CSS = 5;

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
  /** Index into the candidate spots last used, kept while it still fits so moving labels do not jump around. */
  spot: number;
}

export type Box = { x: number; y: number; w: number; h: number };

export class QuantityLabels {
  enabled = true;
  private sim: Simulation | null = null;
  private groups: Group[] = [];
  private badge: HTMLDivElement;
  /** Label boxes of the last frame (world px), so the velocity arrows can keep their numbers off them. */
  boxes: Box[] = [];

  constructor(card: HTMLElement) {
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
    for (const pill of pillsFor(sim.scene, analysis)) {
      const g = this.groups.find((x) => x.part === pill.part);
      if (g) g.pills.push(pill);
      else this.groups.push({ part: pill.part, pills: [pill], spot: 0 });
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
    const worldW = ctx.canvas.width / pxScale;
    const worldH = ctx.canvas.height / pxScale;
    const h = PILL_H_CSS * css;
    const gap = GAP_CSS * css;
    const pad = PAD_CSS * css;
    const font = `800 ${FONT_CSS * css}px Nunito, "Avenir Next", system-ui, sans-serif`;
    const srcFont = `700 ${SRC_FONT_CSS * css}px Nunito, "Avenir Next", system-ui, sans-serif`;
    const placed: Box[] = [];
    // Labels never cover a part of the drawing (its own or another one's): moving parts by their body's box,
    // fixed ones (wheel, launch point) by their clearance circle.
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
      const spots = spotsFor(part, w, H, gap);
      const fits = (c: Point) => {
        const b = { x: c.x - w / 2, y: c.y - H / 2, w, h: H };
        return (
          b.x >= 2 * css &&
          b.y >= 2 * css &&
          b.x + w <= worldW - 2 * css &&
          b.y + H <= worldH - 2 * css &&
          !placed.some((o) => overlap(o, b)) &&
          !keepBoxes.some((o) => overlap(o, b)) &&
          !keepCircles.some((k) => boxCircleOverlap(b, k.c, k.r))
        );
      };
      let k = group.spot < spots.length && fits(spots[group.spot]) ? group.spot : spots.findIndex(fits);
      let c: Point;
      if (k >= 0) {
        group.spot = k;
        c = spots[k];
      } else {
        // Nothing fits cleanly: the preferred spot, kept on the picture.
        k = 0;
        c = {
          x: Math.min(Math.max(spots[0].x, w / 2 + 2 * css), worldW - w / 2 - 2 * css),
          y: Math.min(Math.max(spots[0].y, H / 2 + 2 * css), worldH - H / 2 - 2 * css),
        };
      }
      placed.push({ x: c.x - w / 2, y: c.y - H / 2, w, h: H });
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
  for (const extra of [0, step, 2 * step]) for (const s of SIDE_ORDER[part.side ?? 'right']) out.push(at(s, extra));
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
  // A length is "your note" on the part that set the scale, "to scale" elsewhere, else from paper = 1 m.
  const length = (part: PartName, symbol = 'L') => {
    const px = measures[part];
    if (!px) return;
    const from: ValueSource = s.note ? (s.note.part === part ? 'note' : 'scaled') : 'assumed';
    add(part, () => `${symbol} = ${formatLength(meters(px, s))}`, () => text(from));
  };
  // Masses: always where they change the motion or energy story; elsewhere only when written.
  const mass = (part: PartName, always: boolean) => {
    const p = parts[part];
    if (!p?.kg || (!always && p.kgFrom !== 'note')) return;
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
      const drawn = scene.physics?.rampAngle;
      const angle = noteFor(analysis, 'angle');
      if (drawn !== undefined) {
        const shown = angle ? angle.value : drawn;
        const off = angle && Math.abs(angle.value - drawn) > 5;
        add('ramp', () => `θ = ${Math.round(shown)}°`, () => (angle ? (off ? `your note, drawn ${Math.round(drawn)}°` : text('note')) : text('drawn')));
      }
      const block = parts.block?.body;
      if (block) {
        const written = noteFor(analysis, 'friction');
        const mu = () => Number((block.plugin as { inclineMu?: number }).inclineMu ?? DEFAULT_FRICTION);
        add('ramp', () => `μ = ${mu().toFixed(2)}`, () => {
          const v = mu();
          if (written) return text(Math.abs(v - written.value) < 1e-6 ? 'note' : 'slider');
          return text(Math.abs(v - DEFAULT_FRICTION) < 1e-6 ? 'assumed' : 'slider');
        });
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
