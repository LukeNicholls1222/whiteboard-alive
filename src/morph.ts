// The morph: after "what the AI saw", the hand-drawn lines turn into the clean figure, then the physics starts.
// Played once per photo (not on rebuilds: typed numbers, Reset, sliders). Everything about it lives in this file:
// the timing, the per-frame drawing and the start / end hooks. Simulation (sim.ts) only asks morphProgress() how far
// it is and calls drawMorph() instead of its normal frame while it runs; physics is frozen until it is done.

import type { BuiltScene } from './types';
import { drawClean, FAINT_ALPHA } from './clean';

/** Hold the drawing as it is while the AI overlay fades out on top (overlay.ts FADE_MS). */
export const MORPH_HOLD_MS = 400;
/** The cross-fade itself. */
export const MORPH_MS = 600;
/** Total time before the physics starts. */
export const MORPH_TOTAL_MS = MORPH_HOLD_MS + MORPH_MS;

/** Called when a morph starts / ends (after its last frame, right before the first physics step). */
export const morphHooks = {
  start: [] as Array<(scene: BuiltScene) => void>,
  end: [] as Array<(scene: BuiltScene) => void>,
};

/** Morph progress 0..1 for the time since it started (0 during the hold), or null once it is over. */
export function morphProgress(elapsedMs: number): number | null {
  if (elapsedMs >= MORPH_TOTAL_MS) return null;
  return Math.max(0, Math.min(1, (elapsedMs - MORPH_HOLD_MS) / MORPH_MS));
}

export interface MorphFrame {
  /** Canvas with the picture's world transform set (paper already filled). */
  ctx: CanvasRenderingContext2D;
  scene: BuiltScene;
  /**
   * From: the whole hand-drawn picture as the scene starts (world px; clean.ts drawnSnapshot). The individual moving
   * cut-outs are scene.sprites (each at its starting pose) and the rest is scene.background, for a per-part effect.
   */
  drawn: HTMLCanvasElement;
  /** To: the clean figure (scene.clean). */
  /** World px per CSS px. */
  px: number;
  /** 0..1 (morphProgress). */
  t: number;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * One frame of the morph. Now: the drawing fades from 1 to the faint background level while the clean figure fades
 * in on top, growing from 96 % to full size about each shape's centre.
 */
export function drawMorph(f: MorphFrame) {
  const { ctx, scene, drawn, px } = f;
  const t = ease(f.t);
  ctx.save();
  ctx.globalAlpha = 1 + (FAINT_ALPHA - 1) * t;
  ctx.drawImage(drawn, 0, 0);
  ctx.restore();
  if (scene.onDraw) {
    ctx.save();
    scene.onDraw(ctx);
    ctx.restore();
  }
  drawClean(ctx, scene.clean ?? [], px, { alpha: t, scale: 0.96 + 0.04 * t });
}
