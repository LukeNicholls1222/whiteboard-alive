// Diagram type -> scene builder. New diagram types plug in here (one file per type).

import type { BuiltScene, DiagramType, SceneBuilder, SceneInput } from '../types';
import { scaleFor } from '../units';
import { contourMask } from './common';
import { buildFallback } from './fallback';
import { buildIncline } from './incline';
import { buildPendulum } from './pendulum';
import { buildProjectile } from './projectile';
import { buildSpring } from './spring';
import { buildPulley } from './pulley';

const BUILDERS: Partial<Record<DiagramType, SceneBuilder>> = {
  pendulum: buildPendulum,
  spring: buildSpring,
  incline: buildIncline,
  projectile: buildProjectile,
  pulley: buildPulley,
  fallback: buildFallback,
};

/** Build the scene for the detected diagram; any failure drops to the fallback so something always moves. */
export function buildScene(full: SceneInput): BuiltScene {
  const input = withoutLabels(full);
  const builder = BUILDERS[input.analysis.diagram] ?? buildFallback;
  // Every scene gets its scale (px per metre, slow-motion factor) from the same rule, see units.ts.
  const finish = (scene: BuiltScene) => {
    scene.scale = scaleFor(input, scene.measures, scene.gravityScale);
    return scene;
  };
  try {
    const scene = builder(input);
    if (scene.bodies.some((b) => !b.isStatic)) return finish(scene);
  } catch (err) {
    console.warn('[scene] builder failed, using fallback', err);
  }
  return finish(buildFallback(input));
}

/**
 * Handwritten values ("1 m", "2 kg") are read by the AI, not simulated: their contours are taken out of what the
 * builders see, and so is their ink (a "0" would otherwise look like a ball, digits like scenery to land on).
 * They stay on the paper image, so the background still shows them.
 */
function withoutLabels(input: SceneInput): SceneInput {
  const ids = new Set(input.analysis.bodies.filter((b) => b.role === 'label').map((b) => b.contourId));
  const labels = input.contours.filter((c) => ids.has(c.id));
  const rest = input.contours.filter((c) => !ids.has(c.id));
  if (!labels.length || !rest.length) return input; // everything "text" would leave nothing to move: ignore
  const mask = contourMask(input, labels, 2);
  const ink = input.ink.slice();
  for (let i = 0; i < ink.length; i++) if (mask[i]) ink[i] = 0;
  return { ...input, contours: rest, ink };
}
