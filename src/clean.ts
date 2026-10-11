// The clean picture: once the drawing is understood, what moves is a tidy textbook-style figure drawn by the app
// (BuiltScene.clean), over the original drawing kept faint in the background (it never moves, so the two can be
// compared). Shapes and positions come from the physics bodies and what the scene builder worked out; nothing here
// reads the AI. Look: Duolingo-like solid fills with a darker edge of the same colour and a slightly darker shadow
// underneath; fixed scenery as dark grey lines.
//
// ?style=drawn brings back the old look (the hand-drawn ink itself moves): the escape hatch for a live demo.

import Matter from 'matter-js';
import type { BuiltScene, CleanPart, CleanTone, Point, SceneInput } from './types';
import { drawSprite } from './sim';

/** True when the page asked for the old look (?style=drawn): hand-drawn cut-outs move, no clean figure. */
export const DRAWN_STYLE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('style') === 'drawn';

/** Opacity of the original drawing behind the clean figure. */
export const FAINT_ALPHA = 0.22;

export const COLORS = {
  mass: { fill: '#ff9600', edge: '#e08600', shadow: '#c97800' },
  device: { fill: '#ce82ff', edge: '#a568cc', shadow: '#9256b8' },
  line: '#4b4b4b',
  solidFill: '#f0f0f0',
} as const;

/** Line widths and sizes in CSS px (converted with the picture's zoom, so they look the same on every photo). */
const CSS = {
  rope: 3,
  support: 3.5,
  hatch: 2,
  hatchGap: 9,
  hatchLen: 8,
  ground: 3.5,
  edge: 2.5,
  shadow: 3.5,
  spring: 3.5,
  spoke: 2.5,
  pin: 4,
  arrow: 3.5,
  arrowHead: 13,
};

/** Does this scene draw the clean figure (default) rather than the hand-drawn cut-outs? */
export function usesClean(scene: BuiltScene): boolean {
  return !DRAWN_STYLE && !!scene.clean?.length;
}

/**
 * The drawing as the scene starts, in world px, in two layers rendered once (before the first step) and drawn faint
 * behind the clean figure: `fixed` = the background and the scene's own hand-drawn parts (ceiling, ramp, cannon),
 * `moving` = every cut-out at its starting pose (transparent elsewhere). The moving layer is what the ghost of
 * "where it started" is made of; it fades away after the morph (morph.ts ghostAlpha) so a resting bob or box is
 * not mistaken for a second one.
 */
export function drawnSnapshot(scene: BuiltScene): { fixed: HTMLCanvasElement; moving: HTMLCanvasElement } {
  const bg = scene.background;
  const layer = () => {
    const c = document.createElement('canvas');
    c.width = bg.width;
    c.height = bg.height;
    return c;
  };
  const fixed = layer();
  const fctx = fixed.getContext('2d')!;
  fctx.drawImage(bg, 0, 0);
  if (scene.drawnOnly) {
    fctx.save();
    scene.drawnOnly(fctx);
    fctx.restore();
  }
  const moving = layer();
  const mctx = moving.getContext('2d')!;
  for (const sp of scene.sprites) drawSprite(mctx, sp);
  return { fixed, moving };
}

/** A body's tidied outline in world px (what drawBody draws), for the morph to trace. */
export function bodyOutline(body: Matter.Body): Point[] {
  const { tidy } = localShape(body);
  const cos = Math.cos(body.angle), sin = Math.sin(body.angle);
  return tidy.map((p) => ({ x: body.position.x + p.x * cos - p.y * sin, y: body.position.y + p.x * sin + p.y * cos }));
}

/**
 * The path a part is drawn along (world px), for the morph's light to trace, and whether it closes. Null for parts
 * without a line of their own (pin, image, sprite). Read at morph time, before the physics moves anything.
 */
export function partOutline(ctx: CanvasRenderingContext2D, p: CleanPart, px: number): { points: Point[]; closed: boolean } | null {
  const circle = (c: Point, r: number, n = 28) => {
    const pts: Point[] = [];
    // Start at the top and go clockwise on screen, so a traced circle closes where it began.
    for (let i = 0; i < n; i++) pts.push({ x: c.x + Math.cos(-Math.PI / 2 + (i / n) * Math.PI * 2) * r, y: c.y + Math.sin(-Math.PI / 2 + (i / n) * Math.PI * 2) * r });
    return pts;
  };
  switch (p.kind) {
    case 'body':
      return { points: bodyOutline(p.body), closed: true };
    case 'ball':
      return { points: circle(p.body.position, Math.max(p.radius, (p.minCss ?? 0) * px)), closed: true };
    case 'wheel':
      return { points: circle(p.center, p.radius), closed: true };
    case 'rope':
      return { points: [p.from(), p.to()], closed: false };
    case 'arc': {
      const pts: Point[] = [];
      const n = 14;
      for (let i = 0; i <= n; i++) {
        const a = p.from + ((p.to - p.from) * i) / n;
        pts.push({ x: p.center.x + Math.cos(a) * p.radius, y: p.center.y + Math.sin(a) * p.radius });
      }
      return { points: pts, closed: false };
    }
    case 'spring':
      return { points: springPoints(p.from(), p.to(), p.coils, p.width), closed: false };
    case 'support':
    case 'arrow':
      return { points: [p.from, p.to], closed: false };
    case 'ground': {
      const v = visible(ctx);
      return { points: [{ x: p.x0 ?? v.x - 10 * px, y: p.y }, { x: p.x1 ?? v.x + v.w + 10 * px, y: p.y }], closed: false };
    }
    case 'solid':
      return p.points.length >= 2 ? { points: p.points, closed: true } : null;
    case 'pin':
    case 'image':
    case 'sprite':
      return null;
  }
}

export interface CleanStyle {
  /** Opacity of the clean figure, 0..1. */
  alpha?: number;
  /** Scale of every shape about its own centre (the morph grows them in). */
  scale?: number;
}

/** Draw the clean figure. `px` = world px per CSS px. */
export function drawClean(ctx: CanvasRenderingContext2D, parts: CleanPart[], px: number, style: CleanStyle = {}) {
  const alpha = style.alpha ?? 1;
  const scale = style.scale ?? 1;
  if (alpha <= 0) return;
  for (const part of parts) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (scale !== 1) {
      const c = partCenter(ctx, part);
      ctx.translate(c.x, c.y);
      ctx.scale(scale, scale);
      ctx.translate(-c.x, -c.y);
    }
    drawPart(ctx, part, px);
    ctx.restore();
  }
}

/** Centre of a part (what it scales about in the morph). */
export function partCenter(ctx: CanvasRenderingContext2D, p: CleanPart): Point {
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  switch (p.kind) {
    case 'body':
    case 'ball':
      return { ...p.body.position };
    case 'sprite':
      return p.sprite.follow.kind === 'stretch' ? Matter.Constraint.pointBWorld(p.sprite.follow.constraint) : { ...p.sprite.follow.body.position };
    case 'wheel':
    case 'arc':
      return p.center;
    case 'rope':
    case 'spring':
      return mid(p.from(), p.to());
    case 'support':
    case 'arrow':
      return mid(p.from, p.to);
    case 'ground': {
      const v = visible(ctx);
      return { x: ((p.x0 ?? v.x) + (p.x1 ?? v.x + v.w)) / 2, y: p.y };
    }
    case 'solid':
      return { x: p.points.reduce((s, q) => s + q.x, 0) / p.points.length, y: p.points.reduce((s, q) => s + q.y, 0) / p.points.length };
    case 'pin':
      return p.at();
    case 'image':
      return { x: p.offset.x + p.image.width / 2, y: p.offset.y + p.image.height / 2 };
  }
}

function visible(ctx: CanvasRenderingContext2D) {
  const t = ctx.getTransform();
  return { x: -t.e / t.a, y: -t.f / t.d, w: ctx.canvas.width / t.a, h: ctx.canvas.height / t.d };
}

function drawPart(ctx: CanvasRenderingContext2D, p: CleanPart, px: number) {
  switch (p.kind) {
    case 'body':
      return drawBody(ctx, p.body, p.tone, px);
    case 'ball': {
      const r = Math.max(p.radius, (p.minCss ?? 0) * px);
      const world = ctx.getTransform();
      ctx.translate(p.body.position.x, p.body.position.y);
      logPose(ctx, world, p.body, null);
      filled(ctx, p.tone, px, r, () => {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
      });
      if (p.spokes) drawSpokes(ctx, r, p.body.angle, COLORS[p.tone].edge, Math.min(CSS.spoke * px, 0.12 * r));
      return;
    }
    case 'wheel':
      return drawWheel(ctx, p.center, p.radius, p.angle(), px);
    case 'rope': {
      const a = p.from(), b = p.to();
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) return;
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = CSS.rope * px;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      return;
    }
    case 'arc':
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = CSS.rope * px;
      ctx.beginPath();
      ctx.arc(p.center.x, p.center.y, p.radius, p.from, p.to);
      ctx.stroke();
      return;
    case 'spring':
      return drawSpring(ctx, p.from(), p.to(), p.coils, p.width, px);
    case 'support':
      return drawSupport(ctx, p.from, p.to, p.side, px);
    case 'ground': {
      const v = visible(ctx);
      const x0 = p.x0 ?? v.x - 10 * px, x1 = p.x1 ?? v.x + v.w + 10 * px;
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = CSS.ground * px;
      ctx.beginPath();
      ctx.moveTo(x0, p.y);
      ctx.lineTo(x1, p.y);
      ctx.stroke();
      return;
    }
    case 'solid':
      if (p.points.length < 3) return;
      ctx.beginPath();
      p.points.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fillStyle = COLORS.solidFill;
      ctx.fill();
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = CSS.support * px;
      ctx.stroke();
      return;
    case 'arrow':
      return drawArrow(ctx, p.from, p.to, px);
    case 'pin': {
      const c = p.at();
      ctx.fillStyle = COLORS.line;
      ctx.beginPath();
      ctx.arc(c.x, c.y, CSS.pin * px, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    case 'image':
      ctx.drawImage(p.image, p.offset.x, p.offset.y);
      return;
    case 'sprite':
      drawSprite(ctx, p.sprite);
      return;
  }
}

/**
 * Solid shape with the Duolingo look: a darker copy a little lower (the shadow), the fill, a darker edge.
 * `size` = the shape's size in world px (a small shape gets a smaller shadow). `path` builds the path.
 */
function filled(ctx: CanvasRenderingContext2D, tone: CleanTone, px: number, size: number, path: () => void) {
  const c = COLORS[tone];
  const drop = Math.min(CSS.shadow * px, 0.18 * size);
  ctx.save();
  ctx.translate(0, drop);
  path();
  ctx.fillStyle = c.shadow;
  ctx.fill();
  ctx.restore();
  path();
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.strokeStyle = c.edge;
  ctx.lineWidth = Math.min(CSS.edge * px, 0.2 * size);
  ctx.stroke();
}

// ---- Bodies ---------------------------------------------------------------------------------------------

/** A body's outline in its own frame (unrotated, centred on its position), tidied up once. */
const shapes = new WeakMap<Matter.Body, { tidy: Point[]; raw: Point[] }>();

function localShape(body: Matter.Body) {
  let s = shapes.get(body);
  if (!s) {
    const cos = Math.cos(-body.angle), sin = Math.sin(-body.angle);
    const raw = body.vertices.map((v) => {
      const dx = v.x - body.position.x, dy = v.y - body.position.y;
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    });
    let size = 0;
    for (const a of raw) for (const b of raw) size = Math.max(size, Math.hypot(a.x - b.x, a.y - b.y));
    // Wobbly hand-drawn hulls have many almost-straight corners: keep only the real ones (within 3.5 % of its size).
    const tidy = simplifyClosed(raw, Math.max(1, 0.035 * size));
    s = { tidy: tidy.length >= 3 ? tidy : raw, raw };
    shapes.set(body, s);
  }
  return s;
}

function drawBody(ctx: CanvasRenderingContext2D, body: Matter.Body, tone: CleanTone, px: number) {
  const { tidy } = localShape(body);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of tidy) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const minSide = Math.min(x1 - x0, y1 - y0);
  const r = Math.min(0.14 * minSide, 10 * px);
  const c = COLORS[tone];
  const drop = Math.min(CSS.shadow * px, 0.18 * minSide);
  // Shadow straight down on screen, whatever the body's angle.
  ctx.save();
  ctx.translate(body.position.x, body.position.y + drop);
  ctx.rotate(body.angle);
  roundedPath(ctx, tidy, r);
  ctx.fillStyle = c.shadow;
  ctx.fill();
  ctx.restore();
  const world = ctx.getTransform();
  ctx.save();
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);
  logPose(ctx, world, body, localShape(body).raw);
  roundedPath(ctx, tidy, r);
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.strokeStyle = c.edge;
  ctx.lineWidth = Math.min(CSS.edge * px, 0.2 * minSide);
  ctx.stroke();
  ctx.restore();
}

/** Convex polygon path with corners rounded by up to r. */
function roundedPath(ctx: CanvasRenderingContext2D, pts: Point[], r: number) {
  const n = pts.length;
  ctx.beginPath();
  const first = { x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2 };
  ctx.moveTo(first.x, first.y);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const rr = Math.max(0, Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2));
    ctx.arcTo(b.x, b.y, c.x, c.y, rr);
  }
  ctx.closePath();
}

/** Douglas-Peucker on a closed polygon (split at the two farthest-apart points). */
function simplifyClosed(pts: Point[], eps: number): Point[] {
  if (pts.length <= 4) return pts;
  let i0 = 0, i1 = 0, best = -1;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > best) {
        best = d;
        i0 = i;
        i1 = j;
      }
    }
  const a = pts.slice(i0, i1 + 1);
  const b = pts.slice(i1).concat(pts.slice(0, i0 + 1));
  const sa = dp(a, eps), sb = dp(b, eps);
  return sa.slice(0, -1).concat(sb.slice(0, -1));
}

function dp(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let far = -1, fi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / len;
    if (d > far) {
      far = d;
      fi = i;
    }
  }
  if (far <= eps) return [a, b];
  return dp(pts.slice(0, fi + 1), eps).slice(0, -1).concat(dp(pts.slice(fi), eps));
}

// ---- Devices and scenery -----------------------------------------------------------------------------

function drawWheel(ctx: CanvasRenderingContext2D, c: Point, r: number, angle: number, px: number) {
  filled(ctx, 'device', px, r * 2, () => {
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  });
  ctx.save();
  ctx.translate(c.x, c.y);
  drawSpokes(ctx, r, angle, COLORS.device.edge, CSS.spoke * px);
  ctx.restore();
  ctx.fillStyle = COLORS.line;
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.min(CSS.pin * px, r * 0.25), 0, Math.PI * 2);
  ctx.fill();
}

/** Two spokes (one through the other) about the origin, turned by `angle`: they show a wheel or ball turning. */
function drawSpokes(ctx: CanvasRenderingContext2D, r: number, angle: number, color: string, width: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (const a of [angle, angle + Math.PI / 2]) {
    const dx = Math.cos(a) * r * 0.78, dy = Math.sin(a) * r * 0.78;
    ctx.beginPath();
    ctx.moveTo(-dx, -dy);
    ctx.lineTo(dx, dy);
    ctx.stroke();
  }
}

/** Evenly spaced zigzag with short straight leads at both ends; follows the ends as they move. */
export function springPoints(a: Point, b: Point, coils: number, width: number): Point[] {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 1) return [a, b];
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const n = { x: -u.y, y: u.x };
  const lead = Math.min(0.12 * L, width);
  const body = L - 2 * lead;
  const pts: Point[] = [a, { x: a.x + u.x * lead, y: a.y + u.y * lead }];
  const zig = Math.max(2, Math.round(coils)) * 2;
  for (let i = 0; i < zig; i++) {
    const t = lead + ((i + 0.5) / zig) * body;
    const s = (i % 2 ? -1 : 1) * width / 2;
    pts.push({ x: a.x + u.x * t + n.x * s, y: a.y + u.y * t + n.y * s });
  }
  pts.push({ x: b.x - u.x * lead, y: b.y - u.y * lead }, b);
  return pts;
}

function drawSpring(ctx: CanvasRenderingContext2D, a: Point, b: Point, coils: number, width: number, px: number) {
  const pts = springPoints(a, b, coils, width);
  const path = () => {
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  };
  // Darker purple underneath, a little lower: the same edge + shadow as the solid shapes.
  ctx.save();
  ctx.translate(0, 1.5 * px);
  path();
  ctx.strokeStyle = COLORS.device.shadow;
  ctx.lineWidth = (CSS.spring + 2) * px;
  ctx.stroke();
  ctx.restore();
  path();
  ctx.strokeStyle = COLORS.device.edge;
  ctx.lineWidth = (CSS.spring + 2) * px;
  ctx.stroke();
  path();
  ctx.strokeStyle = COLORS.device.fill;
  ctx.lineWidth = CSS.spring * px;
  ctx.stroke();
}

function drawSupport(ctx: CanvasRenderingContext2D, a: Point, b: Point, side: Point, px: number) {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 1) return;
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const sl = Math.hypot(side.x, side.y) || 1;
  const s = { x: side.x / sl, y: side.y / sl };
  // Hatching: short slanted strokes on the support's side, 45° to the line.
  const gap = CSS.hatchGap * px, len = CSS.hatchLen * px;
  const d = { x: (s.x + u.x) * Math.SQRT1_2 * len * Math.SQRT2, y: (s.y + u.y) * Math.SQRT1_2 * len * Math.SQRT2 };
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = CSS.hatch * px;
  ctx.beginPath();
  for (let t = gap / 2; t < L; t += gap) {
    const p = { x: a.x + u.x * t, y: a.y + u.y * t };
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + d.x * 0.7, p.y + d.y * 0.7);
  }
  ctx.stroke();
  ctx.lineWidth = CSS.support * px;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawArrow(ctx: CanvasRenderingContext2D, a: Point, b: Point, px: number) {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 1) return;
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const head = Math.min(CSS.arrowHead * px, 0.4 * L);
  const base = { x: b.x - u.x * head, y: b.y - u.y * head };
  ctx.strokeStyle = ctx.fillStyle = COLORS.line;
  ctx.lineWidth = CSS.arrow * px;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(base.x + u.x * head * 0.3, base.y + u.y * head * 0.3);
  ctx.stroke();
  const w = head * 0.6;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(base.x - u.y * w, base.y + u.x * w);
  ctx.lineTo(base.x + u.y * w, base.y - u.x * w);
  ctx.closePath();
  ctx.lineWidth = 1.5 * px;
  ctx.fill();
  ctx.stroke();
}

// ---- Helpers for scene builders ---------------------------------------------------------------------------

/**
 * The ink under `mask` recoloured to the scenery grey, as a fixed image (drawn scenery the clean figure keeps, e.g. a
 * cannon or cliff a ball can hit). Null if there is no ink.
 */
export function inkImage(input: SceneInput, mask: (i: number) => boolean): { image: HTMLCanvasElement; offset: Point } | null {
  const { width: W, height: H, ink } = input;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!ink[i] || !mask(i)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y + y0) * W + x + x0;
      if (!ink[i] || !mask(i)) continue;
      const o = (y * w + x) * 4;
      img.data[o] = 0x4b;
      img.data[o + 1] = 0x4b;
      img.data[o + 2] = 0x4b;
      img.data[o + 3] = 230;
    }
  ctx.putImageData(img, 0, 0);
  return { image: c, offset: { x: x0, y: y0 } };
}

/** Hatched support perpendicular to the direction `toward` (unit), centred on `at`, `half` px each side; hatch away from `toward`. */
export function supportAcross(at: Point, toward: Point, half: number): CleanPart {
  const n = { x: -toward.y, y: toward.x };
  return {
    kind: 'support',
    from: { x: at.x - n.x * half, y: at.y - n.y * half },
    to: { x: at.x + n.x * half, y: at.y + n.y * half },
    side: { x: -toward.x, y: -toward.y },
  };
}

// ---- Dev check: is every clean body drawn exactly on its physics body? -----------------------------------

interface PoseLog {
  /** Largest distance between the drawn centre and body.position, world px. */
  center: number;
  /** Largest distance between the drawn outline's (untidied) corners and the body's vertices, world px. */
  vertex: number;
  frames: number;
}
const poseLog: PoseLog | null = import.meta.env.DEV ? { center: 0, vertex: 0, frames: 0 } : null;
if (poseLog) (window as any).__cleanPose = poseLog;

/**
 * Dev only. Called with the body's translate/rotate applied on top of `world` (the picture's transform): maps the
 * shape's own origin and corners back to world px and compares them with body.position and body.vertices.
 */
function logPose(ctx: CanvasRenderingContext2D, world: DOMMatrix, body: Matter.Body, corners: Point[] | null) {
  if (!poseLog) return;
  const local = world.inverse().multiply(ctx.getTransform());
  const c = local.transformPoint(new DOMPoint(0, 0));
  poseLog.center = Math.max(poseLog.center, Math.hypot(c.x - body.position.x, c.y - body.position.y));
  if (corners)
    corners.forEach((p, i) => {
      const w = local.transformPoint(new DOMPoint(p.x, p.y));
      const v = body.vertices[i];
      if (v) poseLog.vertex = Math.max(poseLog.vertex, Math.hypot(w.x - v.x, w.y - v.y));
    });
  poseLog.frames++;
}
