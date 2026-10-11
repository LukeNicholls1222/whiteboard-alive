// Tidy-up for the clean figure: a hand-drawn line that was meant to be straight but leans a little, or a spring that
// was meant to meet the middle of a box but misses it, is put where it was meant to be.
//
// Rules (the same for every scene):
//   - within TIDY_MAX_DEG of horizontal / vertical = meant to be horizontal / vertical: straightened. Steeper than that
//     = drawn slanted on purpose: kept as drawn. A ramp's slope and a pendulum's starting angle are never touched
//     (they are the physics);
//   - springs and ropes meet the middle of the face of the body they hold.
// The physics is built from the tidied shapes (bodies, fixed points, constraints), so what moves is exactly what is
// drawn. Physical values (lengths, angles) are measured on the tidied shapes.
//
// Each tidied clean part remembers where it was drawn (CleanPart.untidy / drawnPoints): the morph traces it there and
// snaps it into place. ?tidy=0 turns all of it off (comparison, escape hatch); ?style=drawn never tidies (the
// hand-drawn cut-outs move, and they must sit on the bodies). ?debug logs every correction as "[tidy] ...".

// Only types are imported: morph.ts uses this file too, and clean.ts / sim.ts import each other.
import type { Point, Untidy } from '../types';

/** Up to this many degrees off horizontal / vertical, a line counts as meant to be straight. */
export const TIDY_MAX_DEG = 15;

const query = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;

/** Tidy-up on (default). Off with ?tidy=0 and in the drawn style (?style=drawn, same test as clean.ts DRAWN_STYLE). */
export const TIDY = query?.get('style') !== 'drawn' && query?.get('tidy') !== '0';

const DEBUG = !!query?.has('debug');

/** ?debug: one console line per scene, e.g. "[tidy] Spring: ceiling 6.2° → 0°, spring 9.1° → vertical". */
export function tidyLog(scene: string, items: string[]) {
  if (DEBUG) console.log(`[tidy] ${scene}: ${items.length ? items.join(', ') : 'nothing to straighten'}${TIDY ? '' : ' (off)'}`);
}

export const deg = (rad: number) => (rad * 180) / Math.PI;
export const fmt = (d: number) => `${Math.abs(d) < 0.05 ? '0' : d.toFixed(1)}°`;

/** Signed angle (degrees) of a line from horizontal, folded into -90..90 (a line has no direction). */
export function lineDeg(v: Point): number {
  let a = deg(Math.atan2(v.y, v.x));
  if (a > 90) a -= 180;
  if (a <= -90) a += 180;
  return a;
}

/** How far (degrees, signed) the direction `v` is from the axis it is closest to, and which axis. */
export function offAxis(v: Point): { axis: 'h' | 'v'; off: number } {
  const a = lineDeg(v);
  if (Math.abs(a) <= 45) return { axis: 'h', off: a };
  return { axis: 'v', off: a > 0 ? a - 90 : a + 90 };
}

/**
 * A direction straightened to the axis it was meant to follow (`axis`), when it is within TIDY_MAX_DEG of it. Keeps
 * which way it points. `off` = how far it was from that axis (degrees, signed).
 */
export function snapDir(v: Point, axis: 'h' | 'v'): { dir: Point; off: number; snapped: boolean } {
  const l = Math.hypot(v.x, v.y) || 1;
  const u = { x: v.x / l, y: v.y / l };
  const a = lineDeg(u);
  const off = axis === 'h' ? a : a > 0 ? a - 90 : a + 90;
  if (!TIDY || Math.abs(off) > TIDY_MAX_DEG) return { dir: u, off, snapped: false };
  const dir = axis === 'h' ? { x: Math.sign(u.x) || 1, y: 0 } : { x: 0, y: Math.sign(u.y) || 1 };
  return { dir, off, snapped: true };
}

/**
 * The straight line the ink makes inside a box (principal axis of the ink pixels): its angle (degrees from
 * horizontal, -90..90), how line-like it is (`elong` = long spread / short spread) and how many pixels went in.
 * `keep(i)` filters pixels (e.g. leave the spring out). Null with too little ink.
 */
export function inkLine(
  ink: Uint8Array,
  W: number,
  H: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  keep: (i: number) => boolean = () => true,
): { deg: number; elong: number; n: number; center: Point } | null {
  const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(W - 1, Math.ceil(box.x1));
  const y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(H - 1, Math.ceil(box.y1));
  let n = 0, sx = 0, sy = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (!ink[i] || !keep(i)) continue;
      n++;
      sx += x;
      sy += y;
    }
  if (n < 20) return null;
  const mx = sx / n, my = sy / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (!ink[i] || !keep(i)) continue;
      const dx = x - mx, dy = y - my;
      cxx += dx * dx;
      cyy += dy * dy;
      cxy += dx * dy;
    }
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  return { deg: lineDeg({ x: Math.cos(angle), y: Math.sin(angle) }), elong: Math.sqrt(l1 / l2), n, center: { x: mx, y: my } };
}

/**
 * A fixed support (ceiling, wall, floor) as drawn near `at`, meant to run along `axis`: the measured ink angle, and the
 * angle the clean figure uses (0 / 90 when it is within TIDY_MAX_DEG of the axis, else as drawn). A blob that is not
 * clearly a line gives null (the clean figure keeps its own straight support).
 */
export function drawnSupport(
  ink: Uint8Array,
  W: number,
  H: number,
  at: Point,
  axis: 'h' | 'v',
  half: number,
  thick: number,
  keep?: (i: number) => boolean,
): { drawn: number; used: number } | null {
  // A band only `thick` across would clip a leaning line and pull the angle towards level: look in a band that holds
  // a line leaning up to ~20° first, then measure again on the ink close to the line found.
  const wide = Math.max(thick, 0.36 * half);
  const box = axis === 'h'
    ? { x0: at.x - half, x1: at.x + half, y0: at.y - wide, y1: at.y + wide }
    : { x0: at.x - wide, x1: at.x + wide, y0: at.y - half, y1: at.y + half };
  let fit = inkLine(ink, W, H, box, keep);
  for (let pass = 0; pass < 2 && fit; pass++) {
    const r = (fit.deg * Math.PI) / 180, n = { x: -Math.sin(r), y: Math.cos(r) }, c = fit.center;
    const near = (i: number) => {
      const x = i % W, y = (i - x) / W;
      return Math.abs((x - c.x) * n.x + (y - c.y) * n.y) <= thick && (!keep || keep(i));
    };
    fit = inkLine(ink, W, H, box, near) ?? fit;
  }
  if (!fit || fit.elong < 4 || fit.n < 40) return null;
  const off = axis === 'h' ? fit.deg : fit.deg > 0 ? fit.deg - 90 : fit.deg + 90;
  // Nearer the other axis than this one: not the support we were looking for.
  if (Math.abs(off) > 45) return null;
  const axisDeg = axis === 'h' ? 0 : 90;
  const drawn = axisDeg + off;
  return { drawn, used: !TIDY || Math.abs(off) > TIDY_MAX_DEG ? drawn : axisDeg };
}

// ---- Where a tidied part was drawn (for the morph) --------------------------------------------------------

/** A part moved from `drawn` to `tidy` without turning. */
export function untidyMove(drawn: Point, tidy: Point): Untidy {
  return { about: { ...tidy }, dx: drawn.x - tidy.x, dy: drawn.y - tidy.y, angle: 0, scale: 1 };
}

/** A part turned by `angle` (radians, drawn = tidy turned by angle) about `about`. */
export function untidyTurn(about: Point, angle: number): Untidy {
  return { about: { ...about }, dx: 0, dy: 0, angle, scale: 1 };
}

/** A line part whose ends went from drawnA / drawnB to tidyA / tidyB: the similarity that maps the tidy ends back. */
export function untidySegment(tidyA: Point, tidyB: Point, drawnA: Point, drawnB: Point): Untidy {
  const lt = Math.hypot(tidyB.x - tidyA.x, tidyB.y - tidyA.y);
  const ld = Math.hypot(drawnB.x - drawnA.x, drawnB.y - drawnA.y);
  if (lt < 1e-6) return untidyMove(drawnA, tidyA);
  const angle = Math.atan2(drawnB.y - drawnA.y, drawnB.x - drawnA.x) - Math.atan2(tidyB.y - tidyA.y, tidyB.x - tidyA.x);
  return { about: { ...tidyA }, dx: drawnA.x - tidyA.x, dy: drawnA.y - tidyA.y, angle: Math.atan2(Math.sin(angle), Math.cos(angle)), scale: ld / lt };
}

/** Did the tidy-up move this part enough to show (0.5 px / 0.2°)? */
export function untidyMatters(u: Untidy, size: number): boolean {
  return Math.hypot(u.dx, u.dy) > 0.5 || Math.abs(u.angle) * Math.max(1, size) > 0.5 || Math.abs(u.scale - 1) * Math.max(1, size) > 0.5;
}

/** Point `p` of the tidy part, `k` of the way back to where it was drawn (1 = drawn, 0 = tidy). */
export function untidyPoint(u: Untidy, p: Point, k = 1): Point {
  const a = u.angle * k, s = 1 + (u.scale - 1) * k;
  const cos = Math.cos(a) * s, sin = Math.sin(a) * s;
  const dx = p.x - u.about.x, dy = p.y - u.about.y;
  return { x: u.about.x + u.dx * k + dx * cos - dy * sin, y: u.about.y + u.dy * k + dx * sin + dy * cos };
}

/** Apply "`k` of the way back to where it was drawn" to a canvas (world px): what is drawn next lands there. */
export function untidyCanvas(ctx: CanvasRenderingContext2D, u: Untidy, k: number) {
  ctx.translate(u.about.x + u.dx * k, u.about.y + u.dy * k);
  ctx.rotate(u.angle * k);
  const s = 1 + (u.scale - 1) * k;
  ctx.scale(s, s);
  ctx.translate(-u.about.x, -u.about.y);
}

/** Point where the ray from `c` along unit `u` leaves the convex polygon `poly` (c inside it). */
export function rayExit(poly: Point[], c: Point, u: Point): Point {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = u.x * ey - u.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - c.x) * ey - (a.y - c.y) * ex) / den;
    const s = ((a.x - c.x) * u.y - (a.y - c.y) * u.x) / den;
    if (t > 1e-9 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  if (!Number.isFinite(best)) return { ...c };
  return { x: c.x + u.x * best, y: c.y + u.y * best };
}
