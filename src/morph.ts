// The morph: after "what the AI saw", the hand-drawn lines turn into the clean figure, then the physics starts.
// Played once per photo (not on rebuilds: typed numbers, Reset, sliders). Everything about it lives in this file:
// the timing, the per-frame drawing and the start / end hooks. Simulation (sim.ts) only asks morphProgress() how far
// it is and calls drawMorph() instead of its normal frame while it runs; physics is frozen until it is done.
//
// What it looks like (times from the start of the morph = the last frame of "what the AI saw"; the morph's first
// frame is that same picture, so there is no gap and no frame of the plain drawing in between):
//   0.00-0.90 s  the drawing dims from the overlay's washed level to its faint background level
//   0.00-0.45 s  the fixed parts (ceiling, ground, ramp, cannon) are traced: a light in the AI's colour for that part
//                runs along the line and the tidy grey line is left behind; the glow fades. The overlay's coloured
//                outline of the same colour is drawn into the light as it runs, and its label shrinks away
//   0.18-0.65 s  the connections (string, rope, spring, arrow) are traced the same way, from the fixed end out
//   0.36-1.2 s   the masses (bob, block, ball, weights) are traced around and snap in: the solid shape pops up with a
//                small overshoot, a ring spreads from it with a few sparks
//   1.08-1.40 s  "alive": the masses lift a little and settle; the value labels and arrows fade in
// Every part's light starts a little after the previous one in its group. prefers-reduced-motion: a short cross-fade
// (the overlay's colours fade with it).

import type { BuiltScene, CleanPart, Point } from './types';
import { drawClean, FAINT_ALPHA, partCenter, partOutline } from './clean';

/** True when the device asks for less motion: the morph is a plain cross-fade. */
const REDUCED = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The morph: total time before the physics starts. */
export const MORPH_MS = REDUCED ? 450 : 1400;

/** The last frame of "what the AI saw" (overlay.ts), in world px, carried into the morph so it can absorb it. */
export interface IntroLayer {
  /** White wash the overlay laid over the drawing (alpha). */
  wash: number;
  /** Coloured outline runs, as the overlay drew them (alpha `runAlpha`, width `runCss` CSS px). */
  runs: Array<{ points: Point[]; closed: boolean; color: string }>;
  runAlpha: number;
  runCss: number;
  /** Labels where the overlay placed them (box top-left + size, world px). */
  labels: Array<{ text: string; color: string; x: number; y: number; w: number; h: number }>;
}

/** How long the ghost of the moving parts (where they were drawn) stays after the morph, fading to nothing. */
export const GHOST_MS = 3000;

// Timeline inside MORPH_MS (ms).
const GROUP_START = { fixed: 0, link: 180, mass: 360 };
const STAGGER = 60;
const STAGGER_MAX = 180;
/** The light runs along a part this long... */
const TRACE_MS = 330;
/** ...then the part snaps in (ring, sparks, overshoot) over this long... */
const POP_MS = 320;
/** ...while the coloured trace fades out. */
const TRACE_FADE_MS = 220;
/** The drawing dims to FAINT_ALPHA over this long. */
const DIM_MS = 900;
const ALIVE_FROM = 1080;
const ALIVE_MS = 320;
/** An overlay label shrinks away this long after the light of its colour starts. */
const LABEL_MS = 240;

/** Called when a morph starts / ends (after its last frame, right before the first physics step). */
export const morphHooks = {
  start: [] as Array<(scene: BuiltScene) => void>,
  end: [] as Array<(scene: BuiltScene) => void>,
};

/** Morph progress 0..1 for the time since it started, or null once it is over. */
export function morphProgress(elapsedMs: number): number | null {
  if (elapsedMs >= MORPH_MS) return null;
  return Math.max(0, Math.min(1, elapsedMs / MORPH_MS));
}

/** Opacity of the value labels and velocity arrows at morph progress t: they come in at the very end. */
export function morphLabelAlpha(t: number): number {
  if (REDUCED) return ease(t);
  return clamp01((t * MORPH_MS - ALIVE_FROM) / ALIVE_MS);
}

/**
 * Opacity of the ghost of the moving parts (their ink where they were drawn) `sinceEndMs` after the morph ended:
 * the faint level at first, gone after GHOST_MS. Null (no morph: a rebuild) = not shown at all.
 */
export function ghostAlpha(sinceEndMs: number | null): number {
  if (sinceEndMs === null) return 0;
  return FAINT_ALPHA * (1 - ease(clamp01(sinceEndMs / GHOST_MS)));
}

export interface MorphFrame {
  /** Canvas with the picture's world transform set (paper already filled). */
  ctx: CanvasRenderingContext2D;
  scene: BuiltScene;
  /** From: the fixed part of the drawing (world px; clean.ts drawnSnapshot). */
  drawn: HTMLCanvasElement;
  /** From: the moving cut-outs at their starting poses (transparent elsewhere). */
  moving: HTMLCanvasElement;
  /** World px per CSS px. */
  px: number;
  /** 0..1 (morphProgress). */
  t: number;
  /** "What the AI saw" as it was last shown; absorbed by the lights (absent: the drawing was shown plain). */
  intro?: IntroLayer | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => t * t * (3 - 2 * t);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeIn = (t: number) => t * t;
/** Overshoots a little past 1 and comes back (easeOutBack). */
const backOut = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** The AI overlay's colours (overlay.ts), so each part's light is the colour its label had. */
const TRACE_COLOR = {
  green: '#58cc02',
  blue: '#1cb0f6',
  orange: '#ff9600',
  purple: '#ce82ff',
  red: '#ff4b4b',
} as const;

type Group = 'fixed' | 'link' | 'mass';

interface PartPlan {
  part: CleanPart;
  group: Group;
  color: string;
  /** Path the light follows, with cumulative lengths; null for parts that just appear. */
  path: { points: Point[]; closed: boolean; cum: number[]; len: number } | null;
  /** Solid shape (pops with a ring) rather than a line. */
  filled: boolean;
  center: Point;
  /** Across the part, world px: its long and short side (the ring starts just outside the short one). */
  size: number;
  minSize: number;
  /** When its light starts, ms into the morph. */
  start: number;
  /** Image parts: their box, for the wipe. */
  box?: { x: number; y: number; w: number; h: number };
}

const plans = new WeakMap<BuiltScene, PartPlan[]>();

function groupOf(p: CleanPart): Group {
  switch (p.kind) {
    case 'support':
    case 'ground':
    case 'solid':
    case 'image':
    case 'pin':
    case 'wheel':
      return 'fixed';
    case 'rope':
    case 'arc':
    case 'spring':
    case 'arrow':
      return 'link';
    case 'body':
    case 'ball':
    case 'sprite':
      return 'mass';
  }
}

function colorOf(p: CleanPart): string {
  switch (p.kind) {
    case 'rope':
    case 'arc':
      return TRACE_COLOR.blue;
    case 'spring':
    case 'wheel':
      return TRACE_COLOR.purple;
    case 'arrow':
    case 'image':
      return TRACE_COLOR.red;
    case 'body':
    case 'ball':
    case 'sprite':
      return TRACE_COLOR.orange;
    default:
      return TRACE_COLOR.green;
  }
}

/** Worked out once per scene, on the morph's first frame (nothing has moved yet). */
function planFor(ctx: CanvasRenderingContext2D, scene: BuiltScene, px: number): PartPlan[] {
  let plan = plans.get(scene);
  if (plan) return plan;
  const parts = scene.clean ?? [];
  const counts: Record<Group, number> = { fixed: 0, link: 0, mass: 0 };
  plan = parts.map((part) => {
    const group = groupOf(part);
    const outline = partOutline(ctx, part, px);
    let path: PartPlan['path'] = null;
    let size = 0, minSize = 0;
    if (outline) {
      const pts = outline.closed ? [...outline.points, outline.points[0]] : outline.points;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
      path = { points: pts, closed: outline.closed, cum, len: cum[cum.length - 1] };
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of outline.points) {
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
        y0 = Math.min(y0, q.y);
        y1 = Math.max(y1, q.y);
      }
      size = Math.max(x1 - x0, y1 - y0);
      minSize = Math.min(x1 - x0, y1 - y0);
    }
    const idx = Math.min(counts[group]++, STAGGER_MAX / STAGGER);
    const filled = part.kind === 'body' || part.kind === 'ball' || part.kind === 'wheel' || part.kind === 'sprite' || part.kind === 'pin';
    const p: PartPlan = { part, group, color: colorOf(part), path, filled, center: partCenter(ctx, part), size, minSize, start: GROUP_START[group] + idx * STAGGER };
    if (part.kind === 'image') p.box = { x: part.offset.x, y: part.offset.y, w: part.image.width, h: part.image.height };
    if (part.kind === 'sprite') {
      p.size = Math.max(part.sprite.image.width, part.sprite.image.height);
      p.minSize = Math.min(part.sprite.image.width, part.sprite.image.height);
      p.box = { x: part.sprite.offset.x, y: part.sprite.offset.y, w: part.sprite.image.width, h: part.sprite.image.height };
    }
    if (part.kind === 'pin') p.size = p.minSize = 8 * px;
    return p;
  });
  plans.set(scene, plan);
  return plan;
}

/**
 * When the light of each overlay colour starts and when its trace is over (ms into the morph), from the plan: a
 * colour the clean figure does not use goes with the fixed parts (the first group).
 */
function colorTimes(plan: PartPlan[]): Map<string, { start: number; end: number }> {
  const m = new Map<string, { start: number; end: number }>();
  for (const p of plan) {
    const c = m.get(p.color);
    if (!c) m.set(p.color, { start: p.start, end: p.start + TRACE_MS });
    else {
      c.start = Math.min(c.start, p.start);
      c.end = Math.max(c.end, p.start + TRACE_MS);
    }
  }
  return m;
}

/**
 * The overlay's picture under the morph: the drawing (dimming from the overlay's washed level to faint), then its
 * coloured runs, each drawn into the light of its colour as the light runs (gone when the trace is over).
 */
function drawIntroUnder(ctx: CanvasRenderingContext2D, f: MorphFrame, ms: number, dim: number, times: Map<string, { start: number; end: number }>) {
  const intro = f.intro;
  const wash = intro ? intro.wash * (1 - dim) : 0;
  if (wash > 0) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = wash;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }
  if (!intro) return;
  const fallback = { start: GROUP_START.fixed, end: GROUP_START.fixed + TRACE_MS };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = intro.runCss * f.px;
  for (const r of intro.runs) {
    const w = times.get(r.color) ?? fallback;
    const gone = ease(clamp01((ms - w.start) / (w.end - w.start)));
    if (gone >= 1 || r.points.length < 2) continue;
    ctx.globalAlpha = intro.runAlpha * (1 - gone);
    ctx.strokeStyle = r.color;
    ctx.beginPath();
    r.points.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    if (r.closed) ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

/** The overlay's labels on top: each shrinks away as the light of its colour starts. */
function drawIntroLabels(ctx: CanvasRenderingContext2D, f: MorphFrame, ms: number, times: Map<string, { start: number; end: number }>) {
  const intro = f.intro;
  if (!intro || !intro.labels.length) return;
  const px = f.px;
  const fallback = { start: GROUP_START.fixed, end: 0 };
  ctx.save();
  ctx.font = `800 ${12 * px}px Nunito, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const l of intro.labels) {
    const start = (times.get(l.color) ?? fallback).start;
    const k = easeIn(clamp01((ms - start) / LABEL_MS));
    if (k >= 1) continue;
    const scale = 1 - k;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.translate(l.x + l.w / 2, l.y + l.h / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = l.color;
    roundRect(ctx, -l.w / 2, -l.h / 2, l.w, l.h, l.h / 2);
    ctx.fill();
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(l.text, 0, 1 * px);
    ctx.restore();
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** One frame of the morph. */
export function drawMorph(f: MorphFrame) {
  const { ctx, scene, drawn, moving, px } = f;
  if (REDUCED) return drawCrossFade(f);
  const ms = f.t * MORPH_MS;
  const dim = ease(clamp01(ms / DIM_MS));
  ctx.save();
  ctx.globalAlpha = 1 + (FAINT_ALPHA - 1) * dim;
  ctx.drawImage(drawn, 0, 0);
  ctx.drawImage(moving, 0, 0);
  ctx.restore();
  if (scene.onDraw) {
    ctx.save();
    scene.onDraw(ctx);
    ctx.restore();
  }
  const plan = planFor(ctx, scene, px);
  const times = colorTimes(plan);
  drawIntroUnder(ctx, f, ms, dim, times);
  const alive = clamp01((ms - ALIVE_FROM) / ALIVE_MS);
  for (const p of plan) {
    const local = ms - p.start;
    if (local < 0) continue;
    const q = clamp01(local / TRACE_MS);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (q < 1) {
      // The light runs along the line; what it has passed is already drawn in the part's colour.
      if (p.path) traceLight(ctx, p, easeOut(q), px);
      else if (p.box) wipeIn(ctx, p, q, px);
    } else {
      const u = clamp01((local - TRACE_MS) / POP_MS);
      const fade = 1 - clamp01((local - TRACE_MS) / TRACE_FADE_MS);
      // The trace under the finished part, fading: a soft halo of the AI's colour around the clean line.
      if (p.path && fade > 0) {
        ctx.globalAlpha = 0.9 * fade;
        strokePath(ctx, p.path.points, p.path.len, p.color, (p.filled ? 5 : 4.5) * px);
        ctx.globalAlpha = 1;
      }
      // Masses lift a little and settle right before the physics takes over.
      const lift = p.group === 'mass' && alive > 0 ? -6 * px * Math.sin(Math.PI * alive) : 0;
      if (lift) ctx.translate(0, lift);
      const scale = p.filled && p.part.kind !== 'pin' ? 0.72 + 0.28 * backOut(easeOut(u)) : 1;
      drawClean(ctx, [p.part], px, { alpha: Math.min(1, u * 5 + 0.15), scale });
      if (lift) ctx.translate(0, -lift);
      if (u < 1) {
        if (p.filled) snapBurst(ctx, p, u, px);
        else if (p.path) {
          // Lines: a brief wide flash along the whole line.
          ctx.globalAlpha = 0.32 * (1 - u);
          strokePath(ctx, p.path.points, p.path.len, p.color, (9 + 6 * u) * px);
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.restore();
  }
  drawIntroLabels(ctx, f, ms, times);
}

/** Reduced motion: the drawing (and the overlay's colours) fade to faint while the clean figure fades in on top. */
function drawCrossFade(f: MorphFrame) {
  const { ctx, scene, drawn, moving, px } = f;
  const t = ease(f.t);
  ctx.save();
  ctx.globalAlpha = 1 + (FAINT_ALPHA - 1) * t;
  ctx.drawImage(drawn, 0, 0);
  ctx.drawImage(moving, 0, 0);
  ctx.restore();
  if (scene.onDraw) {
    ctx.save();
    scene.onDraw(ctx);
    ctx.restore();
  }
  // Every overlay colour and label goes over the whole cross-fade.
  const all = new Map<string, { start: number; end: number }>();
  const ms = f.t * MORPH_MS;
  const span = { start: 0, end: MORPH_MS };
  for (const r of f.intro?.runs ?? []) all.set(r.color, span);
  for (const l of f.intro?.labels ?? []) all.set(l.color, span);
  drawIntroUnder(ctx, f, ms, t, all);
  drawClean(ctx, scene.clean ?? [], px, { alpha: t });
  if (f.intro) {
    const labels = new Map<string, { start: number; end: number }>();
    for (const l of f.intro.labels) labels.set(l.color, { start: 0, end: 0 });
    // LABEL_MS is shorter than the cross-fade: scale the time so the labels shrink over the whole of it.
    drawIntroLabels(ctx, f, (ms * LABEL_MS) / MORPH_MS, labels);
  }
}

/** Stroke the first `upTo` world px of a polyline. */
function strokePath(ctx: CanvasRenderingContext2D, pts: Point[], upTo: number, color: string, width: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  let left = upTo;
  for (let i = 1; i < pts.length && left > 0; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg <= left) ctx.lineTo(b.x, b.y);
    else ctx.lineTo(a.x + ((b.x - a.x) * left) / seg, a.y + ((b.y - a.y) * left) / seg);
    left -= seg;
  }
  ctx.stroke();
}

/** Point at `d` world px along a planned path. */
function pointAt(path: NonNullable<PartPlan['path']>, d: number): Point {
  const { points, cum } = path;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = points[i - 1], b = points[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const k = clamp01((d - cum[i - 1]) / seg);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** The light at `q` (0..1) along the part's path: the passed part of the line in colour, a glowing head at the tip. */
function traceLight(ctx: CanvasRenderingContext2D, p: PartPlan, q: number, px: number) {
  const path = p.path!;
  const d = path.len * q;
  if (d > 0) {
    ctx.globalAlpha = 0.95;
    strokePath(ctx, path.points, d, p.color, (p.filled ? 5 : 4.5) * px);
  }
  const tip = pointAt(path, d);
  glow(ctx, tip, p.color, 11 * px);
}

/** Soft round light: white core, the colour around it, nothing at the edge. */
function glow(ctx: CanvasRenderingContext2D, at: Point, color: string, r: number) {
  const g = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, r);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.3, color + 'e6');
  g.addColorStop(1, color + '00');
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Image / sprite parts (drawn scenery kept as ink): revealed left to right behind a vertical light. */
function wipeIn(ctx: CanvasRenderingContext2D, p: PartPlan, q: number, px: number) {
  const b = p.box!;
  const x = b.x + b.w * easeOut(q);
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x - 2 * px, b.y - 2 * px, x - b.x + 2 * px, b.h + 4 * px);
  ctx.clip();
  drawClean(ctx, [p.part], px);
  ctx.restore();
  const g = ctx.createLinearGradient(x - 8 * px, 0, x + 2 * px, 0);
  g.addColorStop(0, p.color + '00');
  g.addColorStop(0.75, p.color + '80');
  g.addColorStop(1, '#ffffffcc');
  ctx.fillStyle = g;
  ctx.fillRect(x - 8 * px, b.y - 3 * px, 10 * px, b.h + 6 * px);
}

/** The snap: a ring spreading from the shape with six sparks, fading as they go. */
function snapBurst(ctx: CanvasRenderingContext2D, p: PartPlan, u: number, px: number) {
  const c = p.center;
  // Just outside the shape; a long thin shape (a bar) gets a ring about its middle, not around its whole length.
  const r0 = Math.min(p.size / 2, p.minSize / 2 + 16 * px, 44 * px);
  const k = easeOut(u);
  ctx.strokeStyle = p.color;
  ctx.globalAlpha = 0.55 * (1 - u);
  ctx.lineWidth = (3 - 2 * u) * px;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r0 + 4 * px + 26 * px * k, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = p.color;
  ctx.globalAlpha = 0.9 * (1 - u * u);
  const dist = r0 + 6 * px + 30 * px * k;
  const dot = (2.6 - 1.4 * u) * px;
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI * 2 + 0.3;
    ctx.beginPath();
    ctx.arc(c.x + Math.cos(a) * dist, c.y + Math.sin(a) * dist, dot, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
