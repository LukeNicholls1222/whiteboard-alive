// Drawing between physics steps. At a slow playback speed (or a big drawing) a frame often runs no step at all
// (playback.ts: Launch at 1× steps about every 4th frame, at 0.11× about every 36th), and a frame without a step
// would draw the same picture again, so the motion stutters. Here every moving body is drawn part of the way from
// where it was before the frame's last step to where it is now, by the StepClock's fraction (0..1) toward the next
// step. Only the picture moves: the bodies are put at that pose for the draw and put back exactly afterwards, so
// the physics (positions, velocities, step count and order) is untouched, and the graph and readouts keep the
// step values.
//
// No sliding through a jump: a body that moved by more than JUMP_PX in one step when it was nearly still the step
// before (a relaunch, a replay, a rebuilt scene), or that was moved outside a step (an entered value, a rebuild),
// is drawn where it is.

import Matter from 'matter-js';

/** A step that moves a body farther than this (world px)... */
export const JUMP_PX = 60;
/** ...and more than this × its previous step's move is a jump (relaunch, replay), not motion. */
const JUMP_RATIO = 2.5;
/** A turn larger than this in one step is drawn as it is (no spin through half a turn). */
const MAX_TURN = Math.PI / 2;

interface Pose {
  x: number;
  y: number;
  a: number;
}

/** Everything setPosition / setAngle touch on one part, to put it back exactly. */
interface PartState {
  part: Matter.Body;
  x: number;
  y: number;
  a: number;
  px: number;
  py: number;
  pa: number;
  verts: number[];
  axes: number[];
  bounds: [number, number, number, number];
}

/** A turning part drawn by angle (a pulley wheel): its angle function is swapped for the draw. */
export interface Turner {
  angle: () => number;
}

const poseOf = (b: Matter.Body): Pose => ({ x: b.position.x, y: b.position.y, a: b.angle });
const same = (p: Pose, b: Matter.Body) => p.x === b.position.x && p.y === b.position.y && p.a === b.angle;

export class PoseLerp {
  /** Pose before the last step of the latest frame that stepped. */
  private before = new Map<Matter.Body, Pose>();
  /** Pose right after that step (a body not there any more was moved outside a step). */
  private after = new Map<Matter.Body, Pose>();
  /** Length of each body's step before that one (jump test). */
  private lastMove = new Map<Matter.Body, number>();
  private turnBefore = new Map<Turner, number>();
  private turnAfter = new Map<Turner, number>();
  private saved: PartState[] = [];
  private savedTurns: Array<[Turner, () => number]> = [];

  /** Forget everything (scene rebuilt, a value changed): the next frames draw the bodies where they are. */
  reset() {
    this.before.clear();
    this.after.clear();
    this.lastMove.clear();
    this.turnBefore.clear();
    this.turnAfter.clear();
  }

  /** Right before a frame's last physics step. */
  beforeStep(bodies: Matter.Body[], turners: Turner[]) {
    for (const b of bodies) {
      const prev = this.after.get(b);
      const prevBefore = this.before.get(b);
      // Length of the step that led here (only when nothing moved the body since).
      if (prev && prevBefore && same(prev, b)) this.lastMove.set(b, Math.hypot(prev.x - prevBefore.x, prev.y - prevBefore.y));
      else this.lastMove.delete(b);
      this.before.set(b, poseOf(b));
    }
    for (const t of turners) this.turnBefore.set(t, t.angle());
  }

  /** Right after that step. */
  afterStep(bodies: Matter.Body[], turners: Turner[]) {
    for (const b of bodies) this.after.set(b, poseOf(b));
    for (const t of turners) this.turnAfter.set(t, t.angle());
  }

  /** Puts the bodies at the drawn pose for `frac` (0 = before the last step, 1 = now). Call restore() after drawing. */
  apply(bodies: Matter.Body[], turners: Turner[], frac: number) {
    this.saved = [];
    this.savedTurns = [];
    const f = Math.min(1, Math.max(0, frac));
    if (f >= 1) return;
    for (const b of bodies) {
      const p0 = this.before.get(b);
      const p1 = this.after.get(b);
      if (!p0 || !p1 || !same(p1, b)) continue;
      const dx = p1.x - p0.x, dy = p1.y - p0.y, da = p1.a - p0.a;
      const d = Math.hypot(dx, dy);
      if (d > JUMP_PX && d > JUMP_RATIO * (this.lastMove.get(b) ?? 0)) continue;
      const turn = Math.abs(da) <= MAX_TURN;
      if (d === 0 && (da === 0 || !turn)) continue;
      for (const part of b.parts) this.saved.push(save(part));
      const k = 1 - f;
      if (d > 0) Matter.Body.setPosition(b, { x: p1.x - dx * k, y: p1.y - dy * k });
      if (turn && da !== 0) Matter.Body.setAngle(b, p1.a - da * k);
    }
    for (const t of turners) {
      const a0 = this.turnBefore.get(t), a1 = this.turnAfter.get(t);
      if (a0 === undefined || a1 === undefined) continue;
      const now = t.angle();
      if (now !== a1 || Math.abs(a1 - a0) > MAX_TURN || a1 === a0) continue;
      const orig = t.angle;
      this.savedTurns.push([t, orig]);
      const drawn = a1 - (a1 - a0) * (1 - f);
      t.angle = () => drawn;
    }
  }

  /** Puts everything back exactly as the physics left it. */
  restore() {
    for (let i = this.saved.length - 1; i >= 0; i--) load(this.saved[i]);
    for (const [t, orig] of this.savedTurns) t.angle = orig;
    this.saved = [];
    this.savedTurns = [];
  }
}

/** Fields Matter keeps on a body that its type definitions leave out. */
type Inner = Matter.Body & { positionPrev: Matter.Vector; anglePrev: number };

// setPosition / setAngle without updateVelocity (the default) shift positionPrev / anglePrev along, so the velocity
// stays; restore() puts every field back anyway.
function save(body: Matter.Body): PartState {
  const part = body as Inner;
  const verts: number[] = [];
  for (const v of part.vertices) verts.push(v.x, v.y);
  const axes: number[] = [];
  for (const v of part.axes ?? []) axes.push(v.x, v.y);
  const bb = part.bounds;
  return {
    part,
    x: part.position.x,
    y: part.position.y,
    a: part.angle,
    px: part.positionPrev.x,
    py: part.positionPrev.y,
    pa: part.anglePrev,
    verts,
    axes,
    bounds: [bb.min.x, bb.min.y, bb.max.x, bb.max.y],
  };
}

function load(s: PartState) {
  const p = s.part as Inner;
  p.position.x = s.x;
  p.position.y = s.y;
  p.angle = s.a;
  p.positionPrev.x = s.px;
  p.positionPrev.y = s.py;
  p.anglePrev = s.pa;
  p.vertices.forEach((v, i) => {
    v.x = s.verts[2 * i];
    v.y = s.verts[2 * i + 1];
  });
  (p.axes ?? []).forEach((v, i) => {
    v.x = s.axes[2 * i];
    v.y = s.axes[2 * i + 1];
  });
  p.bounds.min.x = s.bounds[0];
  p.bounds.min.y = s.bounds[1];
  p.bounds.max.x = s.bounds[2];
  p.bounds.max.y = s.bounds[3];
}
