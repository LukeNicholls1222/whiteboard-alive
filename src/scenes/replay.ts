// Replay for scenes that come to rest (incline, falling objects): once everything has stopped, the final
// picture stays for a moment and then the whole scene plays again from the start, so a drawing never just
// sits there. Same feel as the projectile and pulley scenes, which loop on their own.
//
// "Stopped" is judged on where the bodies are, not on how fast they move at this instant: a body resting on the
// floor in Matter keeps a tiny contact jitter (its speed never reaches zero), but its position hardly changes.
// So a body is still when, over the last WINDOW_MS, no point of it moved more than STILL × its own size.
//
// A frictionless box that lands against a wall or on its edge rocks back and forth for seconds without going
// anywhere. That rocking is damped out (SETTLE_DAMP) while a body stays roughly in place (SETTLE_TRAVEL), so
// "it arrived" and "it stopped" are about half a second apart instead of four.
//
// The still picture is timed on screen (playback.ts): stopped -> replay is about STOPPED_S at every playback speed,
// not 9 s at 0.11× (steps come 9 times slower there). The settling is judged in steps as before (same physics at
// every speed); only "still" may look back over fewer steps when the full window would fill more than WINDOW_SCREEN_S
// on screen (0.11×), with the limits cut in the same proportion, so it is the same speed limit.

import Matter from 'matter-js';
import { STEP_MS } from '../sim';
import { ScreenWait, screenSecondsPerStep, stepsForScreen } from '../playback';

/** Length of the look-back window for "has it moved?". */
const WINDOW_MS = 500;
/** Still: no point of the body moved more than this × its size (or MIN_PX) over the window. */
const STILL = 0.02;
const MIN_PX = 1.5;
/** Settling: the centre stayed within this × size over the window, but the body still wobbles... */
const SETTLE_TRAVEL = 0.12;
/** ...then its velocity and spin are scaled by this every step (≈ 0.08 left after 0.5 s). */
const SETTLE_DAMP = 0.92;
/** At most this much screen time of the window is used for "still" (never fewer than MIN_STILL_STEPS steps). */
const WINDOW_SCREEN_S = 0.75;
const MIN_STILL_STEPS = 15;
/** Stopped -> replay on screen: the still window (its steps at the current speed) plus the frozen hold after it. */
const STOPPED_S = 1;
/** The frozen hold is never shorter than this on screen. */
const MIN_HOLD_S = 0.3;

/** Warm-start caches Matter keeps on a body between steps (not in the type definitions). */
interface BodyCache {
  positionImpulse: Matter.Vector;
  constraintImpulse: Matter.Vector & { angle: number };
}

interface Pose {
  x: number;
  y: number;
  a: number;
}

const sizeOf = (b: Matter.Body) => Math.max(b.bounds.max.x - b.bounds.min.x, b.bounds.max.y - b.bounds.min.y, 1);

/**
 * onStep hook: when all `bodies` have stayed in place for WINDOW_MS, hold them there (STOPPED_S on screen in all),
 * then put every one back to the position, angle, velocity and spin it has right now. Call it after the scene has set
 * its starting velocities. `timeFactor`: the scene's, read when it runs (playback.ts turns steps into screen time).
 */
export function replayWhenStopped(bodies: Matter.Body[], timeFactor: () => number): (engine: Matter.Engine) => void {
  const start = bodies.map((b) => ({
    b,
    position: { ...b.position },
    angle: b.angle,
    velocity: { ...b.velocity },
    spin: b.angularVelocity,
    size: sizeOf(b),
  }));
  const windowSteps = Math.round(WINDOW_MS / STEP_MS);
  const wait = new ScreenWait(MIN_HOLD_S, timeFactor);
  /** Last `windowSteps + 1` poses of every body (oldest first). */
  let history: Pose[][] = start.map(() => []);
  /** Poses the bodies are held at once they have stopped. */
  let frozen: Pose[] | null = null;

  return (engine) => {
    if (frozen) {
      // Asleep: keep the stopped picture exactly still (no contact jitter), then replay.
      frozen.forEach((p, i) => {
        const b = start[i].b;
        Matter.Body.setPosition(b, { x: p.x, y: p.y });
        Matter.Body.setAngle(b, p.a);
        Matter.Body.setVelocity(b, { x: 0, y: 0 });
        Matter.Body.setAngularVelocity(b, 0);
      });
      if (!wait.tick()) return;
      replay(engine);
      return;
    }

    const still = Math.min(windowSteps, Math.max(MIN_STILL_STEPS, stepsForScreen(WINDOW_SCREEN_S, timeFactor())));
    let allStill = true;
    start.forEach((s, i) => {
      const { b, size } = s;
      const h = history[i];
      h.push({ x: b.position.x, y: b.position.y, a: b.angle });
      if (h.length > windowSteps + 1) h.shift();
      if (h.length <= windowSteps) {
        allStill = false;
        return;
      }
      // Farthest any point of the body got from where it is now: centre offset + turn × half its size. `reach` over
      // the last `still` steps only (the whole window, except at 0.11×), `travel` over the whole window.
      const now = h[h.length - 1];
      let travel = 0, reach = 0;
      h.forEach((p, k) => {
        const d = Math.hypot(p.x - now.x, p.y - now.y);
        travel = Math.max(travel, d);
        if (k >= h.length - 1 - still) reach = Math.max(reach, d + (Math.abs(p.a - now.a) * size) / 2);
      });
      if (reach <= Math.max(STILL * size, MIN_PX) * (still / windowSteps)) return;
      allStill = false;
      if (travel < SETTLE_TRAVEL * size) {
        Matter.Body.setVelocity(b, { x: b.velocity.x * SETTLE_DAMP, y: b.velocity.y * SETTLE_DAMP });
        Matter.Body.setAngularVelocity(b, b.angularVelocity * SETTLE_DAMP);
      }
    });
    if (!allStill) return;
    frozen = start.map((s) => ({ x: s.b.position.x, y: s.b.position.y, a: s.b.angle }));
    // The window just shown was already still: the hold fills the rest of STOPPED_S on screen.
    wait.seconds = Math.max(MIN_HOLD_S, STOPPED_S - still * screenSecondsPerStep(timeFactor()));
    wait.reset();
  };

  function replay(engine: Matter.Engine) {
    frozen = null;
    history = start.map(() => []);
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
  }
}
