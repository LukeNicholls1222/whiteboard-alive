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
// This module has no imports besides units.ts (a leaf), so the node tests run it directly.

import { DEFAULT_KG, STEP_S } from '../units';
import type { Scale, ValueSource, ViewRect } from '../types';

/** ω² per step² of the tuned default (1 kg on the default spring): about a 1 s swing on screen, as before. */
export const DEFAULT_OMEGA2 = 0.01;

/** Engine time unit (one physics step) in physical seconds for this drawing. */
const stepSeconds = (s: Scale) => STEP_S * s.timeFactor;

/** The tuned default spring constant (N/m) for this drawing: DEFAULT_KG swings with DEFAULT_OMEGA2. */
export const defaultSpringK = (s: Scale) => (DEFAULT_KG * DEFAULT_OMEGA2) / stepSeconds(s) ** 2;

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
 * k and m from what was entered: an entered k is used as it is (else the tuned default), an entered mass as it is
 * (else DEFAULT_KG). Neither depends on the other.
 */
export function springSetup(kEntered: number | undefined, kgEntered: number | undefined, s: Scale): SpringSetup {
  const kg = kgEntered && kgEntered > 0 ? kgEntered : DEFAULT_KG;
  const typed = kEntered !== undefined && kEntered > 0;
  const k = typed ? kEntered : defaultSpringK(s);
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
// A block near the photo's edge used to swing (and point its velocity arrow) past the picture. The scene's view
// (sim.ts) is worked out from the whole swing, never from where the block is now, so the picture holds still.

/** Room around the block at its turning points, as a share of the picture's width (a few CSS px). */
export const BLOCK_PAD = 0.012;
/** Room past the velocity arrow's tip, share of the picture's width: vectors.ts stops an arrow 10.5 CSS px from the edge. */
export const ARROW_PAD = 0.045;

export interface SpringSwing {
  /** Photo size, world px: the picture always shows all of it. */
  photoW: number;
  photoH: number;
  /** The block's bounding box at u = 0 (where it was drawn), world px. */
  block: ViewRect;
  /** Unit direction of +u (exactly along x or y). */
  axis: { x: number; y: number };
  /** Middle of the swing, u (px). */
  eq: number;
  /** Half the swing, px. */
  amp: number;
}

export interface ViewLimits {
  /** Longest velocity arrow as a share of the picture's short side (vectors.ts LMAX_FRACTION). */
  arrowFraction: number;
  /** Picture height / width limits (sim.ts MIN_VIEW_ASPECT, MAX_VIEW_ASPECT). */
  minAspect: number;
  maxAspect: number;
}

/**
 * What the picture must show so the block (at both turning points) and its velocity arrow (as long as it gets, at any
 * point of the swing) stay inside, with a few px to spare; null = the photo already holds it all. Never smaller than
 * `prev` (a view shown before for the same photo), and never lower (height / width) than the photo: a wider view gets
 * paper above and below, so the picture's CSS height does not shrink when a value changes.
 */
export function springView(s: SpringSwing, lim: ViewLimits, prev: ViewRect | null = null): ViewRect | null {
  const { photoW: W, photoH: H, block: b, axis, eq, amp } = s;
  const lowest = Math.min(Math.max(H / W, lim.minAspect), lim.maxAspect);
  let x0 = Math.min(0, prev ? prev.x : 0), y0 = Math.min(0, prev ? prev.y : 0);
  let x1 = Math.max(W, prev ? prev.x + prev.w : W), y1 = Math.max(H, prev ? prev.y + prev.h : H);
  const ax = Math.abs(axis.x), ay = Math.abs(axis.y);
  const cx = b.x + b.w / 2 + axis.x * eq, cy = b.y + b.h / 2 + axis.y * eq;
  // The arrow grows with the picture (a share of its short side), so the box is grown until it settles.
  for (let i = 0; i < 24; i++) {
    const w = x1 - x0, h = y1 - y0;
    const lmax = lim.arrowFraction * Math.min(w, h);
    const pad = BLOCK_PAD * w;
    // Along the swing: the block's far face at each turning point, and the arrow's tip (the block at u_eq + A cos θ,
    // the arrow at most lmax · |sin θ| ahead of it: never past √(A² + lmax²) from the middle).
    const arrow = Math.hypot(amp, lmax) + ARROW_PAD * w;
    const nx0 = Math.min(x0, b.x + axis.x * eq - ax * amp - pad, cx - ax * arrow);
    const nx1 = Math.max(x1, b.x + b.w + axis.x * eq + ax * amp + pad, cx + ax * arrow);
    const ny0 = Math.min(y0, b.y + axis.y * eq - ay * amp - pad, cy - ay * arrow);
    const ny1 = Math.max(y1, b.y + b.h + axis.y * eq + ay * amp + pad, cy + ay * arrow);
    let gx = 0, gy = 0;
    const nw = nx1 - nx0, nh = ny1 - ny0;
    if (nh < lowest * nw) gy = (lowest * nw - nh) / 2;
    else if (nh > lim.maxAspect * nw) gx = (nh / lim.maxAspect - nw) / 2;
    const grown = nx0 - gx < x0 - 0.01 || nx1 + gx > x1 + 0.01 || ny0 - gy < y0 - 0.01 || ny1 + gy > y1 + 0.01;
    x0 = nx0 - gx;
    x1 = nx1 + gx;
    y0 = ny0 - gy;
    y1 = ny1 + gy;
    if (!grown) break;
  }
  if (x0 > -0.5 && y0 > -0.5 && x1 < W + 0.5 && y1 < H + 0.5) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
