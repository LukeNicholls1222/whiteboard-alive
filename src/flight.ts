// Projectile flight numbers: the textbook range / highest point / flight time of a shot fired from a height, and the
// meter that reads the same three numbers off the running ball (scenes/projectile.ts), so the graph card can show
// measured next to theory. No runtime imports: tested in plain Node (tests/flight.test.ts).
//
// Matter integrates semi-implicit Euler: v ← v + g, x ← x + v. Started with the textbook velocity, its stepped
// flight is the parabola of a launch g/2 slower upwards (one step short over a whole flight). Handing it
// v − g/2 instead (steppedLaunch) puts every stepped position exactly on the textbook parabola x₀ + v t + ½ g t².

import type { FlightNumbers, Point } from './types';

export type { FlightNumbers };

/**
 * Textbook flight without air: speed v (m/s) at `elevDeg` above level, from `h` metres above the landing level, in
 * gravity g (m/s²). R = v cosθ · (v sinθ + √((v sinθ)² + 2gh)) / g, top h + (v sinθ)² / 2g, T = (v sinθ + √(…)) / g.
 * Null without gravity (it never comes down).
 */
export function flightTheory(v: number, elevDeg: number, h: number, g: number): FlightNumbers | null {
  if (!(g > 0) || !(v >= 0)) return null;
  const th = (elevDeg * Math.PI) / 180;
  const vx = v * Math.cos(th), vy = v * Math.sin(th);
  const disc = vy * vy + 2 * g * h;
  if (disc < 0) return null;
  const time = (vy + Math.sqrt(disc)) / g;
  return { range: Math.abs(vx) * time, maxHeight: h + (vy > 0 ? (vy * vy) / (2 * g) : 0), time };
}

/** Velocity to give the Matter body (px per step) so its stepped flight lies on the parabola of `v` (screen y down). */
export const steppedLaunch = (v: Point, gStep: number): Point => ({ x: v.x, y: v.y - gStep / 2 });

/**
 * Where within the next step the ball's centre comes down through `yLand`: the step starts at `p` with Matter's
 * velocity `vPrev` (px per step, as body.velocity reads after a step), gravity `g` px per step². Fraction 0..1 of
 * the step, or null when it does not get there this step (or is already below it).
 */
export function landingFraction(p: Point, vPrev: Point, g: number, yLand: number): number | null {
  if (p.y >= yLand) return null;
  if (p.y + vPrev.y + g < yLand) return null;
  // On the parabola through p: y(t) = p.y + c t + ½ g t², c = vPrev.y + g/2 (the next position is p.y + vPrev.y + g).
  const c = vPrev.y + g / 2;
  const d = yLand - p.y;
  let t: number;
  if (g > 1e-12) t = (-c + Math.sqrt(Math.max(0, c * c + 2 * g * d))) / g;
  else t = c > 1e-12 ? d / c : 1;
  return Math.min(1, Math.max(0, t));
}

/** One finished flight in world units: px, px, physics steps (fractional). */
export interface FlightTrack {
  /** Horizontal distance from the launch point to the landing point. */
  range: number;
  /** Highest point of the ball's centre above the level it landed at. */
  rise: number;
  steps: number;
  /** Gravity during the flight, px per step² (a flight that saw gravity change is not reported). */
  gStep: number;
  /** Landing point (the ball's centre). */
  land: Point;
}

/**
 * Follows one flight, fed after every engine step: the landing is found from the step's start (position and Matter
 * velocity), so the floor's push-back in that same step does not hide it.
 */
export class FlightMeter {
  private p: Point = { x: 0, y: 0 };
  private v: Point = { x: 0, y: 0 };
  private x0 = 0;
  private minY = 0;
  private n = 0;
  private g = 0;
  private done = true;
  private spoilt = false;

  /** The ball leaves `start` with Matter velocity `vSet` (what was handed to setVelocity) under gravity `gStep`. */
  launch(start: Point, vSet: Point, gStep: number) {
    this.p = { ...start };
    this.v = { ...vSet };
    this.x0 = start.x;
    this.minY = start.y;
    this.n = 0;
    this.g = gStep;
    this.done = false;
    this.spoilt = false;
  }

  /**
   * After an engine step: the ball's position and velocity now, gravity px per step², and the centre's height when
   * resting on the ground at x. Returns the flight once, in the step it comes down; null otherwise.
   */
  step(pos: Point, vel: Point, gStep: number, yLandAt: (x: number) => number): FlightTrack | null {
    if (this.done) return null;
    if (Math.abs(gStep - this.g) > 1e-9 * Math.max(1, Math.abs(this.g))) this.spoilt = true;
    const yLand = yLandAt(this.p.x + this.v.x);
    const f = landingFraction(this.p, this.v, gStep, yLand);
    if (f !== null) {
      this.done = true;
      const land = { x: this.p.x + this.v.x * f, y: yLand };
      return this.spoilt ? null : { range: Math.abs(land.x - this.x0), rise: yLand - Math.min(this.minY, yLand), steps: this.n + f, gStep: this.g, land };
    }
    this.n++;
    this.p = { ...pos };
    this.v = { ...vel };
    this.minY = Math.min(this.minY, pos.y);
    return null;
  }

  /** Stop following (landed on something else, stopped at the picture's edge). */
  stop() {
    this.done = true;
  }
}
