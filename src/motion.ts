// Smoothed velocity of every body the user sees moving, updated once per physics step by the Simulation
// (right after the step, before any listener). The velocity arrows and the graph's Speed both read it, so the
// card and the arrow print the same number for the same body in the same frame.

import type Matter from 'matter-js';
import type { BuiltScene } from './types';
import { STEP_S } from './units';

/**
 * Thresholds in screen px/s: how arrows appear and smooth is a visual matter and must not depend on how many
 * metres the drawing represents. Same values as before physical units existed (0.12 / 0.08 / 0.5 "m/s" at the
 * old fixed 1000/9.8 px per metre).
 */
const OLD_PX_PER_M = 1000 / 9.8;
/** Hysteresis so a body at rest does not flicker an arrow on and off. */
const SHOW_PX_S = 0.12 * OLD_PX_PER_M;
const HIDE_PX_S = 0.08 * OLD_PX_PER_M;
/**
 * Light smoothing (weight of the newest step), only while slow: that is where contact jitter would make a tiny
 * arrow twitch. Faster than SMOOTH_BELOW the velocity is used as is.
 */
const SMOOTH = 0.5;
const SMOOTH_BELOW_PX_S = 0.5 * OLD_PX_PER_M;
/** A jump larger than this (world px in one step) is a reset/relaunch: drop the smoothing history. */
const JUMP_PX = 60;

export interface Track {
  /** Smoothed velocity, px per physics step. */
  vx: number;
  vy: number;
  x: number;
  y: number;
  /** Fast enough to show an arrow (with hysteresis). */
  shown: boolean;
}

export class MotionTracker {
  /** Bodies a sprite of the drawing follows (never static ones, never stretched springs). */
  readonly bodies: Matter.Body[] = [];
  private tracks = new Map<Matter.Body, Track>();

  constructor(scene: BuiltScene) {
    for (const sp of scene.sprites) {
      const f = sp.follow;
      if (f.kind === 'stretch' || f.body.isStatic || this.bodies.includes(f.body)) continue;
      this.bodies.push(f.body);
    }
  }

  update() {
    for (const b of this.bodies) {
      const p = b.position;
      let t = this.tracks.get(b);
      if (!t || Math.hypot(p.x - t.x, p.y - t.y) > JUMP_PX) {
        t = { vx: b.velocity.x, vy: b.velocity.y, x: p.x, y: p.y, shown: false };
        this.tracks.set(b, t);
      } else {
        // Smooth only when it was slow and still is, so a sudden stop (landing, end of the ramp) is exact too.
        const raw = Math.hypot(b.velocity.x, b.velocity.y) / STEP_S;
        const prev = Math.hypot(t.vx, t.vy) / STEP_S;
        // A reversal (turning point of a swing or spring) is shown at once, never averaged towards zero.
        const sameWay = b.velocity.x * t.vx + b.velocity.y * t.vy > 0;
        const k = sameWay && Math.max(raw, prev) < SMOOTH_BELOW_PX_S ? SMOOTH : 1;
        t.vx += (b.velocity.x - t.vx) * k;
        t.vy += (b.velocity.y - t.vy) * k;
        t.x = p.x;
        t.y = p.y;
      }
      t.shown = this.screenSpeed(t) >= (t.shown ? HIDE_PX_S : SHOW_PX_S);
    }
  }

  get(b: Matter.Body): Track | undefined {
    return this.tracks.get(b);
  }

  /** Smoothed speed in px per screen second. */
  screenSpeed(t: Track): number {
    return Math.hypot(t.vx, t.vy) / STEP_S;
  }

  /** The fastest tracked body right now (smoothed), or null before the first step. */
  fastest(): { body: Matter.Body; track: Track } | null {
    let best: { body: Matter.Body; track: Track } | null = null;
    for (const body of this.bodies) {
      const track = this.tracks.get(body);
      if (track && (!best || Math.hypot(track.vx, track.vy) > Math.hypot(best.track.vx, best.track.vy))) best = { body, track };
    }
    return best;
  }
}
