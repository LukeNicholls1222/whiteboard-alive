// Shared contracts. Scene builders, the AI layer and the vision layer all speak these types.

import type Matter from 'matter-js';

export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One connected ink stroke group found by OpenCV. Coordinates are in working-image pixels. */
export interface Contour {
  id: number;
  /** Douglas-Peucker simplified outline. */
  points: Point[];
  /** Convex hull of the outline (used for physics shapes). */
  hull: Point[];
  bbox: BBox;
  centroid: Point;
  /** Filled area in px². */
  area: number;
  /** Ink pixel count (stroke length proxy for thin lines). */
  inkPixels: number;
  /** True if the stroke encloses a hole (e.g. a drawn circle or box outline). */
  hasHole: boolean;
}

export type DiagramType = 'pendulum' | 'spring' | 'incline' | 'projectile' | 'pulley' | 'fallback';

export type BodyRole =
  | 'pivot' // fixed point / ceiling
  | 'rope' // string / rod
  | 'bob' // pendulum mass
  | 'spring'
  | 'mass' // block / weight
  | 'incline'
  | 'ground'
  | 'wheel' // pulley wheel
  | 'cannon'
  | 'arrow'
  | 'projectile'
  | 'other';

export interface AIBody {
  contourId: number;
  role: BodyRole;
  static: boolean;
  mass: number;
}

export interface AIConstraint {
  type: 'rope' | 'spring' | 'pin';
  from: number;
  to: number;
}

export interface Analysis {
  diagram: DiagramType;
  confidence: number;
  bodies: AIBody[];
  constraints: AIConstraint[];
  params: SimParams;
  explanation: string;
  /** Where the analysis came from (for the debug/status line). */
  source: 'gemini' | 'heuristic' | 'cached';
}

export interface SimParams {
  /** m/s². */
  gravity: number;
  [key: string]: number;
}

/** Everything a scene builder needs. Built once per photo. */
export interface SceneInput {
  width: number;
  height: number;
  /** Cleaned paper image (ink on flat paper colour), same size as width/height. */
  paper: HTMLCanvasElement;
  /** Binary ink mask: 255 = ink. */
  ink: Uint8Array;
  contours: Contour[];
  analysis: Analysis;
}

/** How a cut-out of the drawing follows the simulation. */
export type SpriteFollow =
  | { kind: 'body'; body: Matter.Body; origin: Point; originAngle: number }
  | { kind: 'swing'; pivot: Point; body: Matter.Body; originAngle: number; originLength: number };

export interface Sprite {
  /** Cut-out image; transparent outside the shape. Positioned at `offset` in working-image space. */
  image: HTMLCanvasElement;
  offset: Point;
  follow: SpriteFollow;
}

export interface BuiltScene {
  bodies: Matter.Body[];
  constraints: Matter.Constraint[];
  sprites: Sprite[];
  /** Paper with the moving parts erased; drawn as the static background. */
  background: HTMLCanvasElement;
  label: string;
  /** Optional per-step hook (after each Engine.update), e.g. to relaunch a projectile. */
  onStep?: (engine: Matter.Engine) => void;
  /** Optional overlay drawn in world coordinates after the background, before the sprites. */
  onDraw?: (ctx: CanvasRenderingContext2D) => void;
}

export type SceneBuilder = (input: SceneInput) => BuiltScene;
