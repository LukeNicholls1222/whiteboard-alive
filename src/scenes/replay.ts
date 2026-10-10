// Replay for scenes that come to rest (incline, falling objects): once everything has stopped, the final
// picture stays for a moment and then the whole scene plays again from the start, so a drawing never just
// sits there. Same feel as the projectile and pulley scenes, which loop on their own.

import Matter from 'matter-js';
import { STEP_MS } from '../sim';

/** A body slower than this (px per step, ≈ 0.03 m/s) and turning slower than this (rad per step) has stopped. */
const STILL_SPEED = 0.05;
const STILL_SPIN = 0.002;
/** Everything has to stay stopped this long before it counts as stopped... */
const SETTLE_MS = 1500;
/** ...and the stopped picture stays on screen this much longer before the replay starts. */
const HOLD_MS = 1500;

/** Warm-start caches Matter keeps on a body between steps (not in the type definitions). */
interface BodyCache {
  positionImpulse: Matter.Vector;
  constraintImpulse: Matter.Vector & { angle: number };
}

/**
 * onStep hook: when all `bodies` have been still for SETTLE_MS + HOLD_MS, put every one back to the position,
 * angle, velocity and spin it has right now. Call it after the scene has set its starting velocities.
 */
export function replayWhenStopped(bodies: Matter.Body[]): (engine: Matter.Engine) => void {
  const start = bodies.map((b) => ({
    b,
    position: { ...b.position },
    angle: b.angle,
    velocity: { ...b.velocity },
    spin: b.angularVelocity,
  }));
  const due = Math.round((SETTLE_MS + HOLD_MS) / STEP_MS);
  let still = 0;
  return (engine) => {
    const moving = bodies.some(
      (b) => Math.hypot(b.velocity.x, b.velocity.y) > STILL_SPEED || Math.abs(b.angularVelocity) > STILL_SPIN,
    );
    still = moving ? 0 : still + 1;
    if (still < due) return;
    still = 0;
    // Forget the old contacts and their cached impulses, so every replay starts exactly like the first run.
    Matter.Pairs.clear(engine.pairs);
    for (const s of start) {
      Matter.Body.setPosition(s.b, s.position);
      Matter.Body.setAngle(s.b, s.angle);
      Matter.Body.setVelocity(s.b, s.velocity);
      Matter.Body.setAngularVelocity(s.b, s.spin);
      const cache = s.b as unknown as BodyCache;
      cache.positionImpulse.x = cache.positionImpulse.y = 0;
      cache.constraintImpulse.x = cache.constraintImpulse.y = cache.constraintImpulse.angle = 0;
    }
  };
}
