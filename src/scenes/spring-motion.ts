// Spring + mass motion: one degree of freedom along the spring, integrated exactly (no Matter constraint).
//
// Matter's soft constraint bled energy every swing (about all of it in 30 periods) and the scene topped it back up a
// little every step, so the energy graph's Total ran as a saw tooth (9-14 % on a straight spring, ~60 % on a slanted
// one) and the engine's ω² was only roughly 6.67 × stiffness. Like the pendulum, the spring now runs its own physics:
//   u'' = −ω² (u − u_eq),   ω² = k / m,   u_eq = (g_along − g_drawn) / ω²
// with u the block's offset along the spring from where it was drawn (the drawing is the rest position under normal
// gravity) and u_eq where gravity and spring balance under the gravity right now (slider, voice, Moon mode). Each
// step rotates (u − u_eq, v / ω) by ω·step, the exact solution of the linear equation: ½ m v² + ½ k (u − u_eq)² stays
// the same for any k, m and amplitude, and the period is exactly 2π√(m/k). k and m are independent: an entered mass
// keeps the spring's k (the swing slows as √m), an entered k keeps the mass.
// This module imports only units.ts and pendulum-view.ts (both leaves), so the node tests run it directly.

import { DEFAULT_KG, STEP_S } from '../units';
import { springDefaultK } from '../defaults';
import type { Scale, ValueSource, ViewRect } from '../types';
import { pendulumTarget, roomOf, type ViewSpec } from './pendulum-view';

/** Engine time unit (one physics step) in physical seconds for this drawing. */
const stepSeconds = (s: Scale) => STEP_S * s.timeFactor;

/**
 * The default spring constant (N/m, defaults.ts): DEFAULT_KG swings with a period of about 3 s. `hangingM` = length
 * of a hanging spring in metres (its stretch m·g/k must fit in it).
 */
export const defaultSpringK = (hangingM?: number) => springDefaultK(hangingM);

export interface SpringSetup {
  /** Spring constant, N/m. */
  k: number;
  kFrom: ValueSource;
  /** Mass on the spring, kg. */
  kg: number;
  /** ω² per step² (engine time). */
  omega2: number;
}

/**
 * k and m from what was entered: an entered k is used as it is (else the default), an entered mass as it is
 * (else DEFAULT_KG). Neither depends on the other. `hangingM` = a hanging spring's drawn length in metres.
 */
export function springSetup(kEntered: number | undefined, kgEntered: number | undefined, s: Scale, hangingM?: number): SpringSetup {
  const kg = kgEntered && kgEntered > 0 ? kgEntered : DEFAULT_KG;
  const typed = kEntered !== undefined && kEntered > 0;
  const k = typed ? kEntered : defaultSpringK(hangingM);
  return { k, kFrom: typed ? 'input' : 'assumed', kg, omega2: (k / kg) * stepSeconds(s) ** 2 };
}

/** The block's motion along the spring, engine units (px, px per step). */
export class SpringOscillator {
  /** Offset along the spring from the drawn position, px (+ = away from the fixed end). */
  u = 0;
  /** Velocity along the spring, px per step. */
  v: number;
  /** ω² per step². */
  readonly omega2: number;
  private gDrawn: number;
  private omega: number;
  private c: number;
  private s: number;
  /** Rest offset u_eq under the gravity of the last step. */
  private rest = 0;

  /**
   * `gDrawn` = gravity along the spring (towards the block, px per step²) for which the drawing is the rest position;
   * `v0` = starting velocity along the spring.
   */
  constructor(omega2: number, gDrawn: number, v0: number) {
    this.omega2 = omega2;
    this.gDrawn = gDrawn;
    this.omega = Math.sqrt(omega2);
    this.c = Math.cos(this.omega);
    this.s = Math.sin(this.omega);
    this.v = v0;
  }

  /** Rest offset under gravity `gAlong` along the spring (px per step²). */
  restAt(gAlong: number) {
    return (gAlong - this.gDrawn) / this.omega2;
  }

  /** One physics step under gravity `gAlong` along the spring, px per step². */
  step(gAlong: number) {
    this.rest = this.restAt(gAlong);
    const x = this.u - this.rest;
    const w = this.omega;
    this.u = this.rest + x * this.c + (this.v / w) * this.s;
    this.v = -x * w * this.s + this.v * this.c;
  }

  /** How far the block is from its rest position (u − u_eq), px, under the gravity of the last step. */
  stretch(): number {
    return this.u - this.rest;
  }

  /** Middle of the swing (u_eq), px, under the gravity of the last step (0 before the first step). */
  get eq(): number {
    return this.rest;
  }

  /** Half the swing, px: how far from u_eq the block turns round. Stays the same until gravity changes. */
  amplitude(): number {
    return Math.hypot(this.u - this.rest, this.v / this.omega);
  }
}

// ---- View: the picture shows the whole swing ----------------------------------------------------------------
// A block near the photo's edge, or a swing that grows (a heavier block or a softer spring under stronger gravity sags
// further), used to leave the picture, and then the picture got taller and pushed the pills under it down. Like the
// pendulum (pendulum-view.ts), the view is worked out from the whole swing, never from where the block is now: the
// box holds the block at both turning points (u_eq ± A), its velocity arrow as long as it gets, and the spring's fixed
// end; the photo while that box fits with its room (CSS px from the edges and the buttons over the top), else the
// smallest view of the photo's own shape whose room holds it, the box in the middle. The picture's CSS height never
// changes; paper fills what lies outside the photo.

/** Room past the block's outline (its stroke), CSS px. */
export const BLOCK_PAD_CSS = 2;
/** Room past the arrow's tip (its outline) and either side of its head, CSS px (vectors.ts: head 8 + outline 2.5). */
export const ARROW_TIP_CSS = 3;
export const ARROW_HALF_CSS = 10.5;

export interface SpringRange {
  /** The block's bounding box at u = 0 (where it was drawn), world px. */
  block: ViewRect;
  /** Unit direction of +u (exactly along x or y). */
  axis: { x: number; y: number };
  /** Middle of the swing, u (px). */
  eq: number;
  /** Half the swing, px. */
  amp: number;
  /** The spring's fixed end, world px (kept on the picture with the swing). */
  anchor?: { x: number; y: number };
  /** When this swing began (gravity change, rebuild): see arrowReach. */
  start?: SwingStart;
}

export interface SwingStart {
  /** Where the block was (u, px) and its velocity along the spring (px per step). */
  u: number;
  v: number;
  /** Fastest the block had gone since the scene was built (px per step; at least the scene's speedHint). */
  vSeen: number;
  /** ω per step. */
  omega: number;
}

/** Share of the fastest speed seen that vectors.ts is sure to have seen too (it smooths slow speeds a little). */
const SEEN_SHARE = 0.9;

/**
 * How far from the middle of the swing the velocity arrow's tip can get. vectors.ts draws speed × k with
 * k ≤ lmax / vRef, vRef = the fastest speed seen (or the speedHint), so once the block has passed the middle the arrow
 * is lmax·|sin θ| and its tip never gets past √(A² + lmax²). Right after a gravity change (or a rebuild) a new swing may
 * be faster than anything seen: a block then moving outward keeps an arrow up to lmax · v / vRef0 until it turns, its
 * tip up to √(A² + (lmax · Aω / vRef0)²) from the middle (and never past A + lmax), vRef0 = max(fastest seen, v0).
 */
export function arrowReach(amp: number, lmax: number, eq: number, start?: SwingStart): number {
  const steady = Math.hypot(amp, lmax);
  if (!start || !(amp > 0)) return steady;
  if (!((start.u - eq) * start.v > 0)) return steady; // moving towards the middle (or still): it passes it first
  const vRef0 = Math.max(SEEN_SHARE * start.vSeen, Math.abs(start.v));
  const top = amp * start.omega;
  const first = vRef0 > 0 ? Math.hypot(amp, (lmax * top) / vRef0) : Infinity;
  return Math.max(steady, Math.min(amp + lmax, first));
}

/**
 * Box (world px) around everything the swing shows: the block at both turning points, and its velocity arrow, at
 * most `lmax` long (vectors.ts: a share of the picture's short side), its tip within arrowReach of the middle.
 * `k` = world px per CSS px of the picture.
 */
export function springBox(r: SpringRange, lmax: number, k: number): ViewRect {
  const { block: b, axis, eq, amp } = r;
  const ax = Math.abs(axis.x), ay = Math.abs(axis.y);
  const pad = BLOCK_PAD_CSS * k;
  const lo = eq - amp, hi = eq + amp;
  let x0 = b.x + Math.min(axis.x * lo, axis.x * hi) - pad, x1 = b.x + b.w + Math.max(axis.x * lo, axis.x * hi) + pad;
  let y0 = b.y + Math.min(axis.y * lo, axis.y * hi) - pad, y1 = b.y + b.h + Math.max(axis.y * lo, axis.y * hi) + pad;
  const cx = b.x + b.w / 2 + axis.x * eq, cy = b.y + b.h / 2 + axis.y * eq;
  const reach = arrowReach(amp, lmax, eq, r.start) + ARROW_TIP_CSS * k;
  const across = ARROW_HALF_CSS * k;
  x0 = Math.min(x0, cx - ax * reach - ay * across);
  x1 = Math.max(x1, cx + ax * reach + ay * across);
  y0 = Math.min(y0, cy - ay * reach - ax * across);
  y1 = Math.max(y1, cy + ay * reach + ax * across);
  if (r.anchor) {
    x0 = Math.min(x0, r.anchor.x - pad);
    x1 = Math.max(x1, r.anchor.x + pad);
    y0 = Math.min(y0, r.anchor.y - pad);
    y1 = Math.max(y1, r.anchor.y + pad);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Whether the picture showing `view` (null = the photo) keeps the block where it is now (u) and its velocity arrow at
 * full length (lmax of that view, in the direction of `v`) inside its room. While a view glides to a new target after
 * a gravity change, the block already runs its new swing; when this fails the view jumps to the target instead.
 */
export function holdsNow(spec: ViewSpec, r: SpringRange, u: number, v: number, arrowFraction: number, view: ViewRect | null): boolean {
  const R = view ?? { x: 0, y: 0, w: spec.photoW, h: spec.photoH };
  const k = R.w / spec.cssW;
  const room = roomOf(R, spec.insets, spec.cssW);
  const { block: b, axis } = r;
  const pad = BLOCK_PAD_CSS * k;
  const bx = b.x + axis.x * u, by = b.y + axis.y * u;
  const lmax = arrowFraction * Math.min(R.w, R.h);
  const s = v > 0 ? 1 : v < 0 ? -1 : 0;
  const tip = s ? lmax + ARROW_TIP_CSS * k : 0;
  const tx = bx + b.w / 2 + axis.x * s * tip, ty = by + b.h / 2 + axis.y * s * tip;
  const inside = (x: number, y: number) => x >= room.x && x <= room.x + room.w && y >= room.y && y <= room.y + room.h;
  return inside(bx - pad, by - pad) && inside(bx + b.w + pad, by + b.h + pad) && inside(tx, ty);
}

/**
 * The view for a swing (pendulumTarget with the spring's box): null = the photo. The arrow's longest length grows with
 * the view (a share of its short side), so the box is worked out again for the view found until that settles (each
 * round needs less: the arrow grows by 0.22 of the view, the room by about 0.9).
 */
export function springTarget(spec: ViewSpec, r: SpringRange, arrowFraction: number): ViewRect | null {
  const aspect = Math.min(spec.bounds.max, Math.max(spec.bounds.min, spec.photoH / spec.photoW));
  let w = spec.photoW;
  let target: ViewRect | null = null;
  for (let i = 0; i < 60; i++) {
    const box = springBox(r, arrowFraction * Math.min(w, aspect * w), w / spec.cssW);
    target = pendulumTarget(spec, box);
    const nw = target ? target.w : spec.photoW;
    if (nw <= w * (1 + 1e-9) + 1e-6) break;
    w = nw;
  }
  return target;
}
