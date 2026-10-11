// Shared contracts. Scene builders, the AI layer and the vision layer all speak these types.

import type Matter from 'matter-js';

export interface Point {
  x: number;
  y: number;
}

/** A rectangle in world px. */
export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
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

export type DiagramType = 'pendulum' | 'spring' | 'incline' | 'projectile' | 'pulley' | 'collision' | 'lever' | 'fallback';

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
  /** Seesaw / lever board lying on its pivot. */
  | 'plank'
  /** Handwritten text / numbers ("1 m", "2 kg"): never simulated (the numbers are typed into the app instead). */
  | 'label'
  | 'other';

/** Parts of a drawing a value the user enters can refer to. */
export type PartName =
  | 'string'
  | 'bob'
  | 'spring'
  | 'block'
  | 'ramp'
  | 'ground'
  | 'ball'
  | 'arrow'
  | 'left weight'
  | 'right weight'
  | 'wheel'
  /** Ball collision: the ball drawn on the left / on the right. */
  | 'left ball'
  | 'right ball'
  /** Projectile: the launch point and what holds it up (launch height and angle). */
  | 'launcher';

export type Quantity = 'length' | 'mass' | 'angle' | 'speed' | 'friction' | 'spring_constant';

/**
 * A value the user typed into "Your numbers" for a part of the drawing (entries.ts). Scenes read them with
 * noteFor (units.ts). The AI never reads numbers off the paper.
 */
export interface Annotation {
  /** As shown, e.g. "1 m". */
  text: string;
  quantity: Quantity;
  /** In this app's units: m, kg, degrees, m/s, μ (no unit), N/m. */
  value: number;
  /** Unit of `value` ('m', 'kg', '°', 'm/s', '', 'N/m'). */
  unit: string;
  part: PartName;
  /** Where it came from: typed into the app. */
  from: 'input';
}

/** Where a value shown on the drawing came from ('input' = typed into "Your numbers"). */
export type ValueSource = 'input' | 'assumed' | 'drawn' | 'auto' | 'slider' | 'adjusted' | 'scaled';

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
  /** Values typed into "Your numbers" (never from the AI). Empty for a fresh photo. */
  annotations?: Annotation[];
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
  | { kind: 'swing'; pivot: Point; body: Matter.Body; originAngle: number; originLength: number }
  /** Stretched/rotated between a fixed anchor and the constraint's moving end (springs). `origin` = moving end as drawn. */
  | { kind: 'stretch'; anchor: Point; constraint: Matter.Constraint; origin: Point };

export interface Sprite {
  /** Cut-out image; transparent outside the shape. Positioned at `offset` in working-image space. */
  image: HTMLCanvasElement;
  offset: Point;
  follow: SpriteFollow;
}

/**
 * Colour family of a filled clean shape: the moving masses (orange), the second of two masses that must be told apart
 * (blue: the right ball of a collision), the devices (purple: wheel, spring) or a seesaw's board (dark grey).
 */
export type CleanTone = 'mass' | 'mass2' | 'device' | 'beam';

/**
 * One shape of the clean, textbook-style picture (clean.ts) the app draws instead of moving the hand-drawn ink.
 * Shapes and positions come only from the physics bodies and what the scene builder worked out (never from the AI).
 * Invisible helper bodies (walls, rails, collision cells) are simply not listed.
 */
export type CleanPart = CleanShape & {
  /**
   * Tidy-up (scenes/tidy.ts): the part as it was drawn = this similarity applied to the part as built. The morph
   * traces it there, then snaps it into place. Absent = drawn where it is.
   */
  untidy?: Untidy;
};

/**
 * Where a tidied part was drawn: p_drawn = about + (dx, dy) + scale · R(angle) · (p − about), p = the tidy point.
 * Only used by the morph; the physics and every later frame use the tidy part.
 */
export interface Untidy {
  about: Point;
  dx: number;
  dy: number;
  /** Radians, clockwise on screen. */
  angle: number;
  scale: number;
}

export type CleanShape =
  /** A rigid body drawn as its own convex outline, corners slightly rounded (blocks, weights, falling objects). */
  | { kind: 'body'; body: Matter.Body; tone: CleanTone }
  /**
   * A round body (bob, ball) of radius `radius` world px; never smaller than `minCss` CSS px on screen. `spokes`: two
   * lines across it turn with the body (a rolling ball), like a pulley wheel's.
   */
  | { kind: 'ball'; body: Matter.Body; radius: number; tone: CleanTone; minCss?: number; spokes?: boolean }
  /** A pulley wheel at a fixed centre, turned by `angle()` (radians), with spokes. */
  | { kind: 'wheel'; center: Point; radius: number; angle: () => number }
  /** String / rope: a straight line between two points (read every frame). */
  | { kind: 'rope'; from: () => Point; to: () => Point }
  /** Rope lying on a wheel: arc around `center` from angle `from` to `to` (radians, clockwise on screen). */
  | { kind: 'arc'; center: Point; radius: number; from: number; to: number }
  /** Zigzag spring between two points (read every frame), `coils` zigzags, `width` world px across. */
  | { kind: 'spring'; from: () => Point; to: () => Point; coils: number; width: number }
  /** Fixed support (ceiling, wall): a line with hatching on the side `side` points to (unit vector). */
  | { kind: 'support'; from: Point; to: Point; side: Point }
  /** Ground line at height `y`; without x0 / x1 it runs across the whole picture. */
  | { kind: 'ground'; y: number; x0?: number; x1?: number }
  /** Fixed solid (ramp, ledge): outlined polygon with a light fill. `drawnPoints` = its corners as drawn (tidy-up). */
  | { kind: 'solid'; points: Point[]; drawnPoints?: Point[] }
  /** Launch arrow (fixed): shaft from `from`, head at `to`. */
  | { kind: 'arrow'; from: Point; to: Point }
  /** Small dark dot (pivot, axle). */
  | { kind: 'pin'; at: () => Point }
  /** A fixed image in world px (drawn scenery kept as ink, recoloured). */
  | { kind: 'image'; image: HTMLCanvasElement; offset: Point }
  /** A cut-out of the photo that keeps moving as before (the "no lines found" patch). */
  | { kind: 'sprite'; sprite: Sprite };

export interface BuiltScene {
  bodies: Matter.Body[];
  constraints: Matter.Constraint[];
  /** The hand-drawn cut-outs that follow the bodies (drawn style; the intro and the morph start from them). */
  sprites: Sprite[];
  /**
   * The clean picture (default style): what is drawn, in order, over the faint original drawing. Absent or empty =
   * the hand-drawn cut-outs move as before. See clean.ts.
   */
  clean?: CleanPart[];
  /**
   * Hand-drawn moving parts the scene draws itself (pulley ropes and wheel), in world coordinates. Drawn style:
   * every frame, after onDraw and before the sprites. Clean style: only once, into the faint picture of the drawing.
   */
  drawnOnly?: (ctx: CanvasRenderingContext2D) => void;
  /** Paper with the moving parts erased; drawn as the static background. */
  background: HTMLCanvasElement;
  label: string;
  /**
   * What part of the world the picture shows (world px), when it is not just the photo (0, 0, width, height): a ramp
   * stretched taller than the photo, a shot that flies past its edges. A function is read every frame (it may follow
   * live gravity) and may return null for "the photo". Past the background the picture is blank paper. See sim.ts.
   */
  view?: ViewRect | (() => ViewRect | null);
  /**
   * Where a point drawn on the photo sits in the world when the scene starts, for scenes that move the drawing
   * itself (incline stretched to an entered angle). Absent = the drawing is shown where it was drawn.
   */
  drawnAt?: (p: Point) => Point;
  /** Optional per-step hook (after each Engine.update), e.g. to relaunch a projectile. */
  onStep?: (engine: Matter.Engine) => void;
  /** Optional overlay drawn in world coordinates after the background, before the sprites. */
  onDraw?: (ctx: CanvasRenderingContext2D) => void;
  /** Optional per-step hook, called before each Engine.update (e.g. to keep a spring from dying out). */
  step?: (engine: Matter.Engine) => void;

  // ---- Physical units (see units.ts). Read-only facts about the drawing; they never change the motion. ----
  /**
   * Drawn size in working-image px of parts a handwritten length can refer to (string = pivot to bob centre,
   * spring = drawn length, ramp = slope edge, ground = drawn ground line, wheel = diameter).
   */
  measures?: Partial<Record<PartName, number>>;
  /** Where each part is (world px, read every frame so labels follow moving parts), its body and mass. */
  parts?: Partial<Record<PartName, PartInfo>>;
  /** The scene integrates gravity × this (the pulley runs its own slower gravity). Default 1. */
  gravityScale?: number;
  /**
   * Top speed the motion is expected to reach, engine px per step, worked out from the scene's own physics at build
   * time (energy, amplitude × ω, ...). The velocity arrows are scaled to it from the very first frame, so an arrow
   * grows with the speed on the first run too; a faster motion than expected still rescales them.
   */
  speedHint?: number;
  /** Values the scene settled itself, in physical units. */
  physics?: {
    /**
     * Spring (scenes/spring-motion.ts): the spring constant in N/m (`value`, entered or the tuned default, never
     * tied to the mass), ω² per step² it swings with, and the block's distance from its rest position right now
     * (`stretch`, world px along the spring), for the energy graph's ½ k d².
     */
    springK?: { from: ValueSource; note?: number; value: number; omega2: number; stretch: () => number };
    /** Projectile: launch speed actually used and the auto-fitted one (lands inside the picture), m/s. */
    launchSpeed?: { value: number; fit: number; from: ValueSource };
    /** Incline: slope angle as drawn, degrees. */
    rampAngle?: number;
    /**
     * Incline: the slope angle the scene runs (degrees), where it came from ('drawn', 'input', or 'adjusted' when the
     * entered angle would not fit on the picture), and the steepest angle this drawing can be stretched to.
     */
    rampAngleUsed?: { value: number; from: ValueSource; max: number };
    /**
     * Incline with a ball on the slope: it rolls (scenes/roll.ts). `inertia` = I / (m r²), `radius` in world px (the
     * graph adds the spin energy ½ I ω²); `measured` = its acceleration down the slope so far, px per step² (null
     * until measured); `slipping` = sliding while it turns (tan θ > 7/2 μ).
     */
    rolling?: { body: Matter.Body; radius: number; inertia: number; measured: () => number | null; slipping: () => boolean };
    /**
     * Collision: each ball's starting speed (m/s, right = +) and where it came from (drawn arrow, auto push or entered),
     * and the speed the drawing alone gives (`drawn`, from `drawnFrom`), shown while nothing is typed.
     */
    ballSpeeds?: Record<'left' | 'right', { value: number; from: ValueSource; drawn: number; drawnFrom: ValueSource }>;
    /** Pendulum / projectile: the scene reads air drag; the factor ×N on real air the switch sets (air.ts). */
    airDrag?: number;
    /** Seesaw: each side's weight and distance from the pivot, and how the plank turns (for the torque card and labels). */
    lever?: LeverInfo;
    /** Projectile: where and how it is fired (cannon, platform, launch height and angle), world px. */
    launch?: LaunchInfo;
    /** Projectile: range, highest point and flight time, measured and in theory (graph card). */
    flight?: FlightInfo;
  };
  /** px per metre and the time factor; set by buildScene for every scene. */
  scale?: Scale;
}

/** Range (m, from right under the launch point to where it lands), highest point above the landing level (m), time (s). */
export interface FlightNumbers {
  range: number;
  maxHeight: number;
  time: number;
}

/** Projectile: the drawn barrel behind the ball (world px, where the scene now runs it). An estimate from the ink. */
export interface LaunchBarrel {
  /** Point the barrel turns about (35 % of the way from its back end to its mouth). */
  pivot: Point;
  /** Back end and mouth, along the drawn launch direction. */
  breech: Point;
  muzzle: Point;
  length: number;
  thickness: number;
  /** Elevation it fires at now and as drawn: degrees above level, towards LaunchInfo.facing. */
  angleDeg: number;
  drawnAngleDeg: number;
}

/** Projectile: the platform (pillar) put under a launcher raised to an entered height, world px. */
export interface LaunchPlatform {
  x0: number;
  x1: number;
  /** Its top (where the launcher stands) and bottom (the ground). */
  top: number;
  bottom: number;
}

/** Projectile: where and how the ball is fired, world px unless named otherwise. */
export interface LaunchInfo {
  /** The ball's centre at launch. */
  start: Point;
  /** +1 = fires to the right, −1 = to the left. */
  facing: 1 | -1;
  /** Elevation (degrees above level) fired at, as drawn, and where it came from ('drawn' or 'input'). */
  angleDeg: number;
  drawnAngleDeg: number;
  angleFrom: ValueSource;
  /** Launch height above the landing level (m): now, as drawn (0 for a shot from the ground), where it came from. */
  heightM: number;
  heightDrawnM: number;
  heightFrom: ValueSource;
  /** How far (world px, + = down) the drawn launcher (cannon, arrow, cliff by the ball) was moved for the entered height. */
  shiftY: number;
  /** The launcher's ink (moved by shiftY), null when only the ball was drawn there. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  barrel: LaunchBarrel | null;
  /** The pillar under a raised launcher (null when the launcher stands as drawn or was lowered). */
  platform: LaunchPlatform | null;
  /** The ground line the ball lands on. */
  groundY: number;
}

/** Projectile: the graph card's flight numbers. */
export interface FlightInfo {
  /** Textbook values (no air) for gravity g m/s², from the launch speed, angle and height the scene runs. */
  theory: (g: number) => FlightNumbers | null;
  /** The last flight that came down under the gravity now on (null before the first landing, after a gravity change). */
  last: () => FlightNumbers | null;
  /** Air resistance is on (the theory is the no-air one). */
  air: () => boolean;
}

/** One side of a seesaw: mass (kg) and distance from the pivot along the plank (m), and where each came from. */
export interface LeverSide {
  kg: number;
  kgFrom: ValueSource;
  d: number;
  dFrom: ValueSource;
  /** Distances (m) this weight can be moved to while the other one keeps its value (none with a single weight). */
  dMin?: number;
  dMax?: number;
}

export interface LeverInfo {
  left: LeverSide | null;
  right: LeverSide | null;
  /** m₁d₁ = m₂d₂ (within drawing tolerance): it rocks and settles level instead of tipping. */
  balanced: boolean;
  /** Balanced only within the drawing's error (a value is estimated from the drawn size): "Nearly balanced", a small tilt. */
  nearly: boolean;
  /** The turning point (world px) and the plank's range of angles (radians, clockwise on screen). */
  pivot: Point;
  thetaMin: number;
  thetaMax: number;
  /** The plank's angle now (radians). */
  theta: () => number;
}

export interface PartInfo {
  /** Current position in world px (label anchor). */
  at: () => Point;
  /** World px to keep clear around `at`, so the label does not cover the part itself. */
  clear?: number;
  /** Preferred side for the label (default: right of the part; center = on the anchor, e.g. inside a ramp). */
  side?: 'right' | 'left' | 'above' | 'below' | 'center';
  /** The moving body of this part, with its physical mass. */
  body?: Matter.Body;
  kg?: number;
  kgFrom?: ValueSource;
}

/** How the drawing maps to real units (units.ts). */
export interface Scale {
  /** Working-image px per metre. */
  pxPerMeter: number;
  /** Physical seconds per screen second (< 1 = slow motion). */
  timeFactor: number;
  /** The entered length that set the scale, if any (else the paper's long side is 1 m). */
  note?: Annotation;
}

export type SceneBuilder = (input: SceneInput) => BuiltScene;
