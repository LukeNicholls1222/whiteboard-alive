// Diagram type -> scene builder. New diagram types plug in here (one file per type).

import type { BuiltScene, DiagramType, SceneBuilder, SceneInput } from '../types';
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
export function buildScene(input: SceneInput): BuiltScene {
  const builder = BUILDERS[input.analysis.diagram] ?? buildFallback;
  try {
    const scene = builder(input);
    if (scene.bodies.some((b) => !b.isStatic)) return scene;
  } catch (err) {
    console.warn('[scene] builder failed, using fallback', err);
  }
  return buildFallback(input);
}
