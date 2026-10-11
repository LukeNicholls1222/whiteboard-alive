// Physical units: the one place that turns the engine's pixels and steps into metres, seconds, kg and joules.
//
// The engine itself never changes. Every scene is tuned at one physics step per 1/60 s of "engine time" and Earth
// gravity is A_SCREEN = 1000 px/s² of that time: the scenes are tuned (and stable) at exactly that.
// A drawing then *represents* a real-size machine:
//   pxPerMeter  how big it is: an entered length for a part sets it (String length 1 m: the drawn string is 1 m
//               long); without one the scene's default (defaults.ts: big enough that one motion takes ~3 s of real
//               time, e.g. a 2.2 m pendulum), else the paper's long side is 1 m;
//   timeFactor  physical seconds per engine second (60 steps), fixed by asking the engine's gravity to be 9.8 m/s²:
//               9.8 = A_SCREEN · gravityScale / pxPerMeter / timeFactor²
// A 960 px paper of 1 m gives timeFactor ≈ 0.33: one step per frame would play the motion at 0.33×. How many steps
// a frame actually runs follows the playback speed the user picks (playback.ts: speed / timeFactor), so every
// reading below, which is per step, stays the same at any speed.
// The gravity slider and Moon mode change the engine's gravity and keep timeFactor, so the Moon reads 1.62 m/s².
// This module has no imports besides types (sim.ts re-exports the step constants from here).

import type Matter from 'matter-js';
import type { Analysis, Annotation, BuiltScene, PartName, Quantity, Scale } from './types';

export const STEP_MS = 1000 / 60;
export const STEP_S = STEP_MS / 1000;
/** Matter's gravity.scale at 9.8 m/s². */
export const BASE_SCALE = 0.001;
/** Gravity at 9.8 m/s² in px per step², as Matter integrates it. */
export const STEP_ACCEL = BASE_SCALE * STEP_MS * STEP_MS;
/** The same in px per screen second² (= 1000). */
export const A_SCREEN = STEP_ACCEL / (STEP_S * STEP_S);
export const EARTH_G = 9.8;
/** Without an entered length, the paper's long side is this many metres. */
export const PAPER_M = 1;
/** Matter 0.20 (2 constraint iterations): a soft constraint swings with ω² ≈ 6.67 × stiffness per step², for any mass (measured 0.0001-0.01). */
export const OMEGA2_PER_STIFFNESS = 6.67;
/** Without an entered mass, every moving body is 1 kg. */
export const DEFAULT_KG = 1;

/**
 * Scale of a drawing: from the first entered length that names a part the scene measured, else the scene's default
 * (`defaultPxPerMeter`, defaults.ts: sized so one motion takes about 3 s of real time), else paper = 1 m.
 * `gravityScale` = how much of the engine's gravity the scene integrates (the pulley runs slower than the engine).
 */
export function scaleFor(
  input: { width: number; height: number; analysis: Pick<Analysis, 'annotations'> },
  measures: Partial<Record<PartName, number>> = {},
  gravityScale = 1,
  defaultPxPerMeter?: number,
): Scale {
  let pxPerMeter = defaultPxPerMeter && defaultPxPerMeter > 0 ? defaultPxPerMeter : Math.max(input.width, input.height) / PAPER_M;
  let note: Annotation | undefined;
  for (const a of input.analysis.annotations ?? []) {
    const px = measures[a.part];
    if (a.quantity !== 'length' || !px || px < 8 || !(a.value > 0)) continue;
    pxPerMeter = px / a.value;
    note = a;
    break;
  }
  pxPerMeter = Math.min(1e6, Math.max(0.5, pxPerMeter));
  const timeFactor = Math.sqrt((A_SCREEN * Math.max(1e-6, gravityScale)) / (EARTH_G * pxPerMeter));
  return { pxPerMeter, timeFactor, note };
}

/** Scale used when a scene somehow has none (a bare 960 px paper of 1 m). */
export const DEFAULT_SCALE: Scale = scaleFor({ width: 960, height: 960, analysis: {} });

export const scaleOf = (scene: BuiltScene): Scale => scene.scale ?? DEFAULT_SCALE;

// ---- Conversions (engine -> physical) ---------------------------------------------------------------

export const meters = (px: number, s: Scale) => px / s.pxPerMeter;
/** Engine seconds (steps × STEP_S) -> physical seconds. */
export const physSeconds = (screenS: number, s: Scale) => screenS * s.timeFactor;
/** Engine speed (px per physics step) -> m/s. */
export const mps = (pxPerStep: number, s: Scale) => pxPerStep / STEP_S / s.pxPerMeter / s.timeFactor;
/** m/s -> engine speed (px per physics step). */
export const pxPerStep = (v: number, s: Scale) => v * s.pxPerMeter * s.timeFactor * STEP_S;
/** Physical spring constant (N/m) of a soft Matter constraint holding `kg`. */
export const springK = (stiffness: number, kg: number, s: Scale) =>
  (kg * OMEGA2_PER_STIFFNESS * stiffness) / (STEP_S * s.timeFactor) ** 2;
/** Engine stiffness that gives a physical spring constant `k` (N/m) for `kg`. */
export const stiffnessFor = (k: number, kg: number, s: Scale) =>
  ((k / kg) * (STEP_S * s.timeFactor) ** 2) / OMEGA2_PER_STIFFNESS;

// ---- Entered values ("Your numbers") ----------------------------------------------------------------

/** The first entered value of this quantity, preferring the given parts in order (any part if none given). */
export function noteFor(analysis: Pick<Analysis, 'annotations'>, quantity: Quantity, parts?: PartName[]): Annotation | undefined {
  const list = (analysis.annotations ?? []).filter((a) => a.quantity === quantity);
  if (!parts) return list[0];
  for (const p of parts) {
    const a = list.find((x) => x.part === p);
    if (a) return a;
  }
  return undefined;
}

/** Physical mass of every moving body the scene named; anything else counts as DEFAULT_KG. */
export function massesOf(scene: BuiltScene): Map<Matter.Body, number> {
  const out = new Map<Matter.Body, number>();
  for (const p of Object.values(scene.parts ?? {})) if (p?.body && p.kg && p.kg > 0) out.set(p.body, p.kg);
  return out;
}

// ---- Formatting (one formatter per quantity, so every readout prints the same number) ----------------

const sig = (v: number, digits = 3) => String(Number(v.toPrecision(digits)));

export const formatSpeed = (v: number) => `${v < 1 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)} m/s`;
export const formatLength = (m: number) => `${m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)} m`;
export const formatMass = (kg: number) => `${sig(kg)} kg`;
export const formatSpringK = (k: number) => `${sig(k)} N/m`;
export const formatSeconds = (s: number) => `${s.toFixed(2)} s`;
export const formatEnergy = (j: number) => `${j >= 100 ? j.toFixed(0) : j >= 10 ? j.toFixed(1) : j.toFixed(2)} J`;
