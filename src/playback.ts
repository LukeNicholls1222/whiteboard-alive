// Playback speed: how fast the screen plays the physical motion, chosen by tapping the speed badge
// (1× -> 0.5× -> 0.33× -> 0.11× -> 1× ...). Starts at 1× (real time) and keeps the choice for later photos.
//
// The physics never changes: a step is always STEP_S × timeFactor physical seconds (units.ts), so speeds, periods,
// accelerations, momentum and energy read the same at any playback speed. Only the number of steps run per frame
// changes: speed / timeFactor (a 1 m paper, timeFactor ≈ 0.33, runs 3 steps per frame at 1× and one step every third
// frame at 0.11×). Fractions are carried over to the next frame; a frame never runs more than MAX_STEPS_PER_FRAME
// steps, and when that cap is reached the badge shows the speed actually played.
//
// No DOM here (tests run it in node).

/** Speeds the badge cycles through, physical seconds per screen second. */
export const SPEEDS = [1, 1 / 2, 1 / 3, 1 / 9] as const;
/** What the badge prints for each speed (as the user asked for them). */
const SPEED_TEXT = ['1×', '0.5×', '0.33×', '0.11×'];
/** Safety cap: physics steps one frame may run. */
export const MAX_STEPS_PER_FRAME = 15;
/**
 * A rate within this share of a simple fraction of steps (n, n/2, n/3 per frame) is played as exactly that fraction,
 * so the steps come in an even rhythm (3 every frame, 1 every third frame) instead of a hitch now and then. On a 1 m
 * paper (timeFactor 0.326) every speed is then 2 % slow, the same for all of them, so 0.11× is exactly 1/9 of 1×.
 */
const SNAP = 0.03;

let index = 0;

/** The chosen speed. */
export const playbackSpeed = (): number => SPEEDS[index];

/** Next speed in the cycle (the badge's tap); returns the new speed. */
export function cycleSpeed(): number {
  index = (index + 1) % SPEEDS.length;
  return SPEEDS[index];
}

/** Physics steps per frame for a speed on a scene with this timeFactor (capped, snapped to a simple fraction when close). */
export function stepRate(speed: number, timeFactor: number): number {
  const r = Math.min(MAX_STEPS_PER_FRAME, speed / Math.max(1e-9, timeFactor));
  for (const d of [1, 2, 3]) {
    const n = Math.round(r * d);
    if (n >= 1 && Math.abs(r - n / d) <= SNAP * r) return n / d;
  }
  return r;
}

/** Speed the screen actually plays (physical s per screen s): the chosen one unless the cap held it back. */
export const playedSpeed = (speed: number, timeFactor: number): number => stepRate(speed, timeFactor) * timeFactor;

/** Whole steps to run each frame for a (possibly fractional) rate; the remainder is carried to the next frame. */
export class StepClock {
  /** Starts almost full, so a slow rate still steps on the very first frame. */
  private acc = 1 - 1e-6;

  next(rate: number): number {
    this.acc += rate;
    const n = Math.floor(this.acc + 1e-9);
    this.acc = Math.max(0, this.acc - n);
    return n;
  }

  /** How far the clock is toward the next step, 0..1 (sim.ts draws the bodies that far between steps). */
  get frac(): number {
    return Math.min(1, Math.max(0, this.acc));
  }
}

// ---- Waits on screen ------------------------------------------------------------------------------------------
// A scene that rests before it plays again (seesaw, pulley, collision, ramp) waits a time the viewer sees: about a
// second on screen at any speed. Counted in steps it would shrink to a blink at 1× (several steps a frame) and
// stretch to ages at 0.11× (one step every few frames), so it is counted in screen seconds, one step at a time.

/** Screen seconds per frame: sim.ts runs one batch of steps per animation frame (60 fps). */
export const FRAME_S = 1 / 60;

/** Screen seconds one physics step takes at this speed on a scene with this timeFactor. */
export const screenSecondsPerStep = (timeFactor: number, speed: number = playbackSpeed()): number =>
  FRAME_S / stepRate(speed, timeFactor);

/** Physics steps that fill `seconds` of screen time at this speed (at least 1). */
export const stepsForScreen = (seconds: number, timeFactor: number, speed: number = playbackSpeed()): number =>
  Math.max(1, Math.round(seconds / screenSecondsPerStep(timeFactor, speed)));

/**
 * A wait of `seconds` on screen, ticked once per physics step. Each tick adds the screen time of one step at the speed
 * chosen right now, so a tap on the badge in the middle of a wait changes only what is left of it.
 */
export class ScreenWait {
  private elapsed = 0;
  seconds: number;
  /** Read on every tick (the scene's scale is set after it is built). */
  private readonly timeFactor: () => number;
  constructor(seconds: number, timeFactor: () => number) {
    this.seconds = seconds;
    this.timeFactor = timeFactor;
  }

  reset() {
    this.elapsed = 0;
  }

  /** One step of waiting: true once `seconds` of screen time have passed since the last reset (then it starts over). */
  tick(): boolean {
    this.elapsed += screenSecondsPerStep(this.timeFactor());
    if (this.elapsed < this.seconds - 1e-9) return false;
    this.elapsed = 0;
    return true;
  }
}

/** "Real time 1×" / "Slow motion 0.5×": the badge's two parts (word, number). */
export function speedLabel(speed: number, timeFactor: number): { word: string; num: string } {
  const played = playedSpeed(speed, timeFactor);
  const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
  const num = i >= 0 && Math.abs(played - speed) <= 0.05 * speed ? SPEED_TEXT[i] : `${Number(played.toPrecision(2))}×`;
  return { word: num === '1×' ? 'Real time' : played < 1 ? 'Slow motion' : 'Fast-forward', num };
}
