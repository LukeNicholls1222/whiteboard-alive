// Default values: what a scene uses when nothing was entered (no pill, no number box, no voice), chosen so that one
// motion takes about TARGET_S of real time at 1x (playback.ts plays real time). A motion of a fraction of a second
// looks wrong, however correct the physics is.
//
// The physics is never slowed down: gravity stays 9.8 m/s² and time is real time. What changes is the default size
// of the drawing (px per metre: a bigger machine moves slower, t ∝ √size at the same g), and where the motion has a
// natural knob, that knob (a softer spring, closer pulley weights, slower collision balls). Every
// readout then says what was really simulated (L = 2.20 m, k = 4.40 N/m, m = 1.10 kg ...).
//
// One motion:
//   Pendulum, Spring      one period
//   Launch                launch to landing
//   Ramp                  from the start down the slope (and along the floor) until friction or the wall stops it
//   Rolling ball          from the start down the slope and along the floor to the picture's edge (the slope alone
//                         at least ROLL_SLOPE_MIN_S)
//   Pulley                from the start until the weight reaches its end
//   Seesaw                from tipping until it rests on the floor (the bounces included)
//   Collision             from the start until the first hit
//   Falling objects       from the start until everything has stopped (the fall itself at least FALL_MIN_S)
//
// An entered length always sets the scale instead (units.ts scaleFor), and every entered value is used as it is: a
// steeper entered angle or a heavier entered weight still moves faster than the default, as it should.
// No DOM here (tests run it in node).

import { A_SCREEN, DEFAULT_KG, EARTH_G, STEP_ACCEL, STEP_S } from './units';

/** Real seconds one default motion takes (aim). */
export const TARGET_S = 3;
/** The range a default motion should land in. */
export const MOTION_MIN_S = 2.5;
export const MOTION_MAX_S = 3.5;

/**
 * px per metre at which a motion lasting `steps` physics steps (the scene integrating `gravityScale` × the engine's
 * gravity) takes `seconds` of real time. A step is STEP_S × timeFactor real seconds and
 * timeFactor² = A_SCREEN · gravityScale / (EARTH_G · pxPerMeter) (units.ts), so
 * pxPerMeter = A_SCREEN · gravityScale · (steps · STEP_S)² / (EARTH_G · seconds²).
 */
export function pxPerMeterForSteps(steps: number, gravityScale = 1, seconds = TARGET_S): number | undefined {
  if (!(steps > 0) || !(gravityScale > 0)) return undefined;
  return (A_SCREEN * gravityScale * (steps * STEP_S) ** 2) / (EARTH_G * seconds ** 2);
}

// ---- Pendulum -----------------------------------------------------------------------------------------------------

/** Default string length, m: T = 2π√(L/g) = 2.98 s (a little more for a wide swing). */
export const PENDULUM_L_M = 2.2;

/** The drawn string (pivot to bob centre, px) is PENDULUM_L_M long. */
export const pendulumPxPerMeter = (stringPx: number) => stringPx / PENDULUM_L_M;

// ---- Spring -------------------------------------------------------------------------------------------------------

/** Default spring constant, N/m: DEFAULT_KG swings with T = 2π√(m/k) = 3.0 s. */
export const SPRING_K = 4.4;
/**
 * A hanging spring is drawn at rest, stretched by m·g/k (2.2 m for 1 kg on 4.4 N/m, the same for any spring with a
 * 3 s period). That stretch is this share of the drawn length, so the spring's own length is the rest (2/3): even
 * on the Moon or with the gravity slider at 0 it never shrinks through its fixed end.
 */
export const SPRING_SAG_SHARE = 1 / 3;

/** A hanging spring drawn `springPx` long: px per metre that makes it long enough for its stretch. Lying: the paper. */
export function springPxPerMeter(springPx: number, hanging: boolean): number | undefined {
  if (!hanging || !(springPx > 0)) return undefined;
  return (springPx * SPRING_SAG_SHARE) / ((DEFAULT_KG * EARTH_G) / SPRING_K);
}

/**
 * Default spring constant, N/m. A hanging spring whose length was entered (`hangingM`, m) is never so soft that its
 * stretch m·g/k passes SPRING_SAG_SHARE of that length (a short entered spring is a stiffer one).
 */
export function springDefaultK(hangingM?: number): number {
  if (!(hangingM && hangingM > 0)) return SPRING_K;
  return Math.max(SPRING_K, (DEFAULT_KG * EARTH_G) / (SPRING_SAG_SHARE * hangingM));
}

// ---- Ramp and rolling ball ---------------------------------------------------------------------------------------

/**
 * Steps a block takes from its start to where it stops (engine units: px, px per step, Earth gravity): down
 * `slopePx` of slope at `angle` (rad) from `v0`, then along the floor (the corner keeps the speed along it,
 * v·cos θ) until friction `mu` stops it or `floorPx` runs out (the wall at the picture's edge).
 */
export function slideSteps(slopePx: number, angle: number, mu: number, v0: number, floorPx: number): number {
  const g = STEP_ACCEL;
  const a = g * (Math.sin(angle) - mu * Math.cos(angle));
  const s = Math.max(0, slopePx);
  if (a <= 0) {
    // Friction wins: the push runs out on the slope.
    const dec = -a;
    if (dec < 1e-12) return v0 > 0 ? s / v0 : 0;
    const stop = (v0 * v0) / (2 * dec);
    if (stop <= s) return v0 / dec;
    const v1 = Math.sqrt(Math.max(0, v0 * v0 - 2 * dec * s));
    return (v0 - v1) / dec + floorSteps(v1 * Math.cos(angle), mu, floorPx);
  }
  const v1 = Math.sqrt(v0 * v0 + 2 * a * s);
  return (v1 - v0) / a + floorSteps(v1 * Math.cos(angle), mu, floorPx);
}

/** Steps on a level floor from speed `v` (px per step) until friction `mu` stops it or `room` px run out. */
function floorSteps(v: number, mu: number, room: number): number {
  if (!(v > 0) || !(room > 0)) return 0;
  const dec = mu * STEP_ACCEL;
  if (dec < 1e-12) return room / v;
  const stop = (v * v) / (2 * dec);
  if (stop <= room) return v / dec;
  return (v - Math.sqrt(v * v - 2 * dec * room)) / dec;
}

/**
 * Steps a ball takes down `slopePx` from rest at acceleration `a` (px per step², roll.ts rollAccel), then along
 * `floorPx` of floor at the speed it reached (rolling resistance is tiny): to where it stops at the picture's edge.
 */
export function rollSteps(slopePx: number, a: number, floorPx: number): { slope: number; total: number } {
  if (!(a > 0) || !(slopePx > 0)) return { slope: 0, total: 0 };
  const slope = Math.sqrt((2 * slopePx) / a);
  const v = a * slope;
  return { slope, total: slope + Math.max(0, floorPx) / v };
}

/** The roll down the slope alone takes at least this (real s): the floor part only adds to it. */
export const ROLL_SLOPE_MIN_S = 2.6;

/** Rolling ball: the whole run takes TARGET_S, and the slope alone at least ROLL_SLOPE_MIN_S. */
export function rollPxPerMeter(steps: { slope: number; total: number }): number | undefined {
  const whole = pxPerMeterForSteps(steps.total);
  const slope = pxPerMeterForSteps(steps.slope, 1, ROLL_SLOPE_MIN_S);
  if (whole === undefined || slope === undefined) return whole ?? slope;
  // Fewer px per metre = a bigger ramp = a slower run.
  return Math.min(whole, slope);
}

// ---- Launch -------------------------------------------------------------------------------------------------------

/**
 * Steps the default shot flies (Earth gravity, px): launched at `speed` px per step `up` (sine of the elevation,
 * screen up positive), coming down `fall` px below the launch point.
 */
export function flightSteps(speed: number, up: number, fall: number): number {
  const g = STEP_ACCEL;
  const vUp = speed * up;
  return (vUp + Math.sqrt(Math.max(0, vUp * vUp + 2 * g * Math.max(0, fall)))) / g;
}

// ---- Pulley -------------------------------------------------------------------------------------------------------

/**
 * Heavier : lighter weight by default. The drawn sizes only say which side is heavier: with nearly equal weights the
 * machine moves at a = g (m₁ − m₂)/(m₁ + m₂) = g/21, the way Atwood's machine slows gravity down to be watched.
 */
export const PULLEY_MASS_RATIO = 1.1;

/** Default weights (relative) for the drawn ones: the bigger drawing PULLEY_MASS_RATIO times the other. */
export function pulleyMasses(left: number, right: number): [number, number] {
  return left > right ? [PULLEY_MASS_RATIO, 1] : [1, PULLEY_MASS_RATIO];
}

/** px per metre at which the falling weight covers `travelPx` in TARGET_S from rest, at g·`aRel` (aRel = Δm / Σm). */
export function pulleyPxPerMeter(travelPx: number, aRel: number): number | undefined {
  if (!(travelPx > 0) || !(aRel > 0)) return undefined;
  return travelPx / (0.5 * EARTH_G * aRel * TARGET_S ** 2);
}

// ---- Seesaw -------------------------------------------------------------------------------------------------------

/**
 * Tipping to the floor, then the bounces (BOUNCE 0.3 in lever-plan.ts) until it rests: the whole is about this many
 * times the tip itself (measured on the drawings).
 */
export const LEVER_SETTLE = 1.6;

/** Seesaw tipping `travel` rad from rest at `alpha` rad per step² (Earth gravity, drawn weights). */
export function leverPxPerMeter(travel: number, alpha: number): number | undefined {
  if (!(travel > 0) || !(alpha > 0)) return undefined;
  return pxPerMeterForSteps(Math.sqrt((2 * travel) / alpha), 1, TARGET_S / LEVER_SETTLE);
}

// ---- Collision ----------------------------------------------------------------------------------------------------

/** The faster ball rolls this fast by default, m/s: momentum and energy read in whole hundredths, not 0.00. */
export const COLLISION_SPEED = 0.5;

/**
 * px per metre at which the faster ball (drawn speed `fastPx` px per step), rolling the `hitSteps` steps to the first
 * hit, covers COLLISION_SPEED × TARGET_S. Undefined (the paper) when they never meet.
 */
export function collisionPxPerMeter(fastPx: number, hitSteps: number | null): number | undefined {
  if (!hitSteps || !(fastPx > 0)) return undefined;
  return (fastPx * hitSteps) / (COLLISION_SPEED * TARGET_S);
}

/**
 * Factor on the drawn starting speeds (from the arrows) so the first hit comes TARGET_S after the start, for a first
 * hit `hitSteps` steps away at the drawn speeds on a scene with this timeFactor. 1 when they never meet.
 */
export function collisionSpeedFactor(hitSteps: number | null, timeFactor: number): number {
  if (!hitSteps || !(hitSteps > 0)) return 1;
  return Math.min(4, Math.max(0.01, (hitSteps * STEP_S * timeFactor) / TARGET_S));
}

// ---- Falling objects ----------------------------------------------------------------------------------------------

/** The fall itself (the slowest body coming down) never takes less than this (real s), however soon things settle. */
export const FALL_MIN_S = 1;
/** A run that never stops (things rolling away) counts as this many times the slowest body's fall. */
export const FALL_SETTLE_MAX = 2.5;

/**
 * Falling objects: the run takes `runSteps` from the start until everything has stopped (measured by the scene; null =
 * it did not stop), the slowest body comes down in `landSteps`. The run takes TARGET_S, the fall at least FALL_MIN_S.
 */
export function fallPxPerMeter(runSteps: number | null, landSteps: number): number | undefined {
  const run = runSteps ?? (landSteps > 0 ? FALL_SETTLE_MAX * landSteps : 0);
  const whole = pxPerMeterForSteps(run);
  const fall = landSteps > 0 ? pxPerMeterForSteps(landSteps, 1, FALL_MIN_S) : undefined;
  if (whole === undefined || fall === undefined) return whole ?? fall;
  // Fewer px per metre = bigger = slower.
  return Math.min(whole, fall);
}
