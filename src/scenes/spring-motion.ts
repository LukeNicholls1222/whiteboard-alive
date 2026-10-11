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
import type { Scale, ValueSource } from '../types';

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
}
