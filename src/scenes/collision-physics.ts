// Two balls on a level floor between two walls, as an exact 1-D event-driven motion (no imports: node-testable).
//
// Matter's contact solver is not used for the collision itself: with stacking contacts and restitution it gains or
// loses momentum a little at every hit, and the point of this scene is that momentum is exactly conserved. Each step
// the next event (the balls touching, or a ball reaching a wall) is found in closed form, everything moves up to it,
// it is resolved, and so on until the step is used up.
//
// Ball-ball hit, coefficient of restitution e (1 = elastic, 0 = they stick):
//   v1' = (m1 v1 + m2 v2 − m2 e (v1 − v2)) / (m1 + m2)
//   v2' = (m1 v1 + m2 v2 + m1 e (v1 − v2)) / (m1 + m2)
// Wall: v' = −e v. A hit closing slower than STICK_V is taken as e = 0 (a ball resting against a wall or against
// the other ball stays there instead of making infinitely many smaller and smaller bounces in finite time).

export interface Ball1D {
  /** Centre along the floor, px. */
  x: number;
  /** Velocity along the floor, px per step (right = +). */
  v: number;
  /** Radius, px. */
  r: number;
  /** Mass (any unit; only ratios matter for the motion). */
  m: number;
}

/** Walls: the left ball's left edge never goes below x0, the right ball's right edge never above x1. */
export interface Walls {
  x0: number;
  x1: number;
}

/** Closing speed (px per step) below which a hit does not bounce. */
export const STICK_V = 0.02;
/** Most events resolved within one step (a ball pinned between the wall and the other ball). */
const MAX_EVENTS = 64;

/** Velocities after a hit of two masses with restitution e (momentum is exactly conserved). */
export function collide(m1: number, v1: number, m2: number, v2: number, e: number): [number, number] {
  const p = m1 * v1 + m2 * v2;
  const M = m1 + m2;
  const rel = v1 - v2;
  return [(p - m2 * e * rel) / M, (p + m1 * e * rel) / M];
}

export const momentum = (b: readonly Ball1D[]) => b.reduce((s, q) => s + q.m * q.v, 0);
export const kinetic = (b: readonly Ball1D[]) => b.reduce((s, q) => s + 0.5 * q.m * q.v * q.v, 0);

export interface StepReport {
  /** Ball-ball hits during the step. */
  hits: number;
  /** Wall hits during the step. */
  walls: number;
}

/**
 * Move the pair (balls[0] left of balls[1]) on by `dt` steps with restitution `e` (ball-ball and walls alike).
 * Changes the balls in place. Positions always stay valid: inside the walls and not overlapping.
 */
export function advance(balls: [Ball1D, Ball1D], dt: number, walls: Walls, e: number): StepReport {
  const [a, b] = balls;
  const E = Math.min(1, Math.max(0, Number.isFinite(e) ? e : 1));
  const rep: StepReport = { hits: 0, walls: 0 };
  let left = dt;
  for (let k = 0; k < MAX_EVENTS && left > 0; k++) {
    const gap = b.x - b.r - (a.x + a.r);
    const tBall = a.v > b.v ? Math.max(0, gap) / (a.v - b.v) : Infinity;
    const tLeft = a.v < 0 ? Math.max(0, a.x - a.r - walls.x0) / -a.v : Infinity;
    const tRight = b.v > 0 ? Math.max(0, walls.x1 - (b.x + b.r)) / b.v : Infinity;
    const t = Math.min(tBall, tLeft, tRight);
    if (t >= left) {
      a.x += a.v * left;
      b.x += b.v * left;
      left = 0;
      break;
    }
    a.x += a.v * t;
    b.x += b.v * t;
    left -= t;
    if (t === tBall) {
      const closing = a.v - b.v;
      [a.v, b.v] = collide(a.m, a.v, b.m, b.v, closing < STICK_V ? 0 : E);
      // Exactly touching (no drift apart or into each other from rounding).
      const mid = (a.x + a.r + b.x - b.r) / 2;
      a.x = mid - a.r;
      b.x = mid + b.r;
      rep.hits++;
    } else if (t === tLeft) {
      a.v = -a.v < STICK_V ? 0 : -E * a.v;
      a.x = walls.x0 + a.r;
      rep.walls++;
    } else {
      b.v = b.v < STICK_V ? 0 : -E * b.v;
      b.x = walls.x1 - b.r;
      rep.walls++;
    }
  }
  if (left > 0) {
    // Out of events (pinned): move what is free and keep everything valid.
    a.x += a.v * left;
    b.x += b.v * left;
  }
  clampPair(balls, walls);
  return rep;
}

/** Push the pair back inside the walls and apart (start positions as drawn, or after a pinned step). */
export function clampPair(balls: [Ball1D, Ball1D], walls: Walls) {
  const [a, b] = balls;
  if (a.x - a.r < walls.x0) a.x = walls.x0 + a.r;
  if (b.x + b.r > walls.x1) b.x = walls.x1 - b.r;
  const overlap = a.x + a.r - (b.x - b.r);
  if (overlap > 0) {
    // Split the overlap, unless one side is against its wall.
    let da = overlap / 2, db = overlap / 2;
    const roomA = a.x - a.r - walls.x0, roomB = walls.x1 - (b.x + b.r);
    if (da > roomA) { db += da - roomA; da = roomA; }
    if (db > roomB) { da += db - roomB; db = roomB; }
    a.x -= da;
    b.x += db;
  }
}

/** Still: |v| under this, px per step... */
export const REST_V = 0.03;
/**
 * ...or under this share of the fastest starting speed. Nothing slows the balls between hits (no friction), so after a
 * few inelastic hits they can creep along for minutes; that counts as stopped (the scene then plays again).
 */
export const SLOW_SHARE = 0.05;
/** Both balls (nearly) still, `start` = the fastest starting speed (px per step). */
export const atRest = (balls: readonly Ball1D[], start = 0) =>
  balls.every((q) => Math.abs(q.v) < Math.max(REST_V, SLOW_SHARE * start));
