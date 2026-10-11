// Matter.js world + renderer. Default: the clean figure (clean.ts) over the faint original drawing, after a short
// morph from the drawing (morph.ts). ?style=drawn: the hand-drawn cut-outs themselves move, as before.

import Matter from 'matter-js';
import decomp from 'poly-decomp';
import { MotionTracker } from './motion';
import { drawClean, drawnSnapshot, FAINT_ALPHA, usesClean } from './clean';
import { drawMorph, ghostAlpha, type IntroLayer, morphHooks, morphLabelAlpha, morphProgress } from './morph';
import { playbackSpeed, StepClock, stepRate } from './playback';
import type { BuiltScene, SimParams, Sprite, ViewRect } from './types';
import { BASE_SCALE, STEP_MS, scaleOf } from './units';
import { pictureHold } from './hold';

// The step constants live in units.ts (a leaf module); re-exported here for the scene builders.
export { STEP_ACCEL, STEP_MS } from './units';

Matter.Common.setDecomp(decomp);

/** ?debug outlines the physics bodies (read once: the query does not change while the page is open). */
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

// ---- View (camera) ------------------------------------------------------------------------------------
// A scene may show more than the photo (BuiltScene.view): the picture keeps the card's width, its height follows
// the view's shape between MIN_VIEW_ASPECT and MAX_VIEW_ASPECT × the width (not the photo's shape: a long flat shot
// gets a wide, low picture), and a view outside that range is shrunk to fit and centred. Without a view the photo
// fills the card exactly as before. The renderer, the overlay and the labels all use these helpers.

/** Tallest picture a view may make, as height / width. */
export const MAX_VIEW_ASPECT = 1.6;
/** Lowest (widest) picture a view may make, as height / width. */
export const MIN_VIEW_ASPECT = 0.45;
/** Paper colour shown where the view reaches past the photo. */
export const PAPER_FILL = 'rgb(251, 250, 246)';

/** The scene's view right now (it may follow live gravity), or null = the photo as it is. */
export function viewOf(scene: BuiltScene): ViewRect | null {
  const v = typeof scene.view === 'function' ? scene.view() : scene.view;
  return v && v.w > 0 && v.h > 0 ? v : null;
}

/** CSS height of the picture for a card `cssW` wide. */
export function pictureCssHeight(view: ViewRect | null, photoW: number, photoH: number, cssW: number): number {
  const h = !view ? (cssW * photoH) / photoW : Math.min(Math.max((cssW * view.h) / view.w, MIN_VIEW_ASPECT * cssW), MAX_VIEW_ASPECT * cssW);
  // A number under the picture is being changed (hold.ts): never shorter than it has been meanwhile.
  if (!pictureHold.on) return h;
  pictureHold.px = Math.max(pictureHold.px, h);
  return pictureHold.px;
}

/**
 * Canvas transform for a canvas of the given device-pixel size: world (x, y) -> (S·x + tx, S·y + ty). A canvas held
 * taller than the picture needs (hold.ts) shows it centred, blank paper above and below.
 */
export function pictureTransform(view: ViewRect | null, photoW: number, canvasW: number, canvasH: number, photoH = 0) {
  if (!view) {
    const S = canvasW / photoW;
    return { S, tx: 0, ty: Math.max(0, (canvasH - photoH * S) / 2) };
  }
  const S = Math.min(canvasW / view.w, canvasH / view.h);
  return { S, tx: (canvasW - view.w * S) / 2 - view.x * S, ty: (canvasH - view.h * S) / 2 - view.y * S };
}

/** The world rectangle a context currently shows (from its transform): labels and arrows stay inside it. */
export function visibleRect(ctx: CanvasRenderingContext2D): ViewRect {
  const t = ctx.getTransform();
  return { x: -t.e / t.a, y: -t.f / t.d, w: ctx.canvas.width / t.a, h: ctx.canvas.height / t.d };
}

export class Simulation {
  engine = Matter.Engine.create();
  private raf = 0;
  private ctx: CanvasRenderingContext2D;
  /** Smoothed velocities of the moving bodies, updated right after every step (arrows and graph share it). */
  readonly motion: MotionTracker;
  /** Called after every physics step (graphs, readouts). A frame may run several steps, or none (playback.ts). */
  stepListeners: Array<(engine: Matter.Engine) => void> = [];
  /** Called once per frame after that frame's physics steps (even when it ran none), before it is drawn. */
  frameListeners: Array<() => void> = [];
  /** Spreads the playback speed's steps over the frames (playback.ts). */
  private clock = new StepClock();
  /** Called after every setParams, whoever made the change (slider, chip, voice, Moon switch). */
  paramListeners: Array<(p: Partial<SimParams>) => void> = [];
  /** Called every frame after the sprites, in world coordinates. `pxScale` = canvas px per world px. */
  drawListeners: Array<(ctx: CanvasRenderingContext2D, scene: BuiltScene, pxScale: number) => void> = [];

  /**
   * Clean style: the drawing as the scene starts, shown faint behind the clean figure (null = drawn style). `fixed` =
   * background and drawn scenery; `moving` = the cut-outs where they were drawn, a ghost that fades after the morph.
   */
  private drawn: { fixed: HTMLCanvasElement; moving: HTMLCanvasElement } | null = null;
  /** performance.now() when the morph started; null = not morphing. */
  private morphStart: number | null = null;
  /** performance.now() when the morph ended (the ghost fades from then); null = no morph was played (a rebuild). */
  private morphEnd: number | null = null;
  /** "What the AI saw" as last shown, for the morph to start from and absorb. */
  private intro: IntroLayer | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    readonly scene: BuiltScene,
    private worldW: number,
    private photoH: number,
  ) {
    this.ctx = canvas.getContext('2d')!;
    Matter.Composite.add(this.engine.world, [...scene.bodies, ...scene.constraints]);
    this.motion = new MotionTracker(scene);
    // Taken before the first step: every cut-out is still where it was drawn.
    if (usesClean(scene)) this.drawn = drawnSnapshot(scene);
  }

  /** True while the morph plays (physics not started yet). */
  get morphing(): boolean {
    return this.morphStart !== null;
  }

  setParams(p: Partial<SimParams>) {
    if (p.gravity !== undefined) this.engine.gravity.scale = (BASE_SCALE * p.gravity) / 9.8;
    // Incline blocks read their Coulomb μ from plugin.inclineMu every step, so friction changes apply live.
    if (p.friction !== undefined)
      for (const b of this.scene.bodies) {
        const plugin = b.plugin as { inclineMu?: number } | undefined;
        if (plugin && plugin.inclineMu !== undefined) plugin.inclineMu = p.friction;
      }
    for (const fn of this.paramListeners) fn(p);
  }

  /** Bottom edge of what is shown, world px (the photo's, or the scene's view). */
  get worldH(): number {
    const v = viewOf(this.scene);
    return v ? v.y + v.h : this.photoH;
  }

  /** Current gravity in m/s² (read back from the engine, so there is one source of truth). */
  get gravity(): number {
    return (this.engine.gravity.scale / BASE_SCALE) * 9.8;
  }

  /**
   * Run. `morph`: first turn the drawing into the clean figure (morph.ts), then start the physics. Only for a new
   * photo after the AI intro; ignored in drawn style. `intro`: the AI overlay's last frame; the morph's first frame
   * (drawn right away, before this returns) is that same picture, so the overlay can be hidden at once.
   */
  start(opts: { morph?: boolean; intro?: IntroLayer | null } = {}) {
    if (opts.morph && this.drawn) {
      this.intro = opts.intro ?? null;
      this.morphStart = performance.now();
      for (const fn of morphHooks.start) fn(this.scene);
      this.draw(0);
    }
    const loop = () => {
      if (this.morphStart !== null) {
        const t = morphProgress(performance.now() - this.morphStart);
        if (t !== null) {
          this.draw(t);
          this.raf = requestAnimationFrame(loop);
          return;
        }
        this.morphStart = null;
        this.morphEnd = performance.now();
        for (const fn of morphHooks.end) fn(this.scene);
      }
      // The playback speed decides how many steps this frame runs; each step is the same physical time as ever.
      const steps = this.clock.next(stepRate(playbackSpeed(), scaleOf(this.scene).timeFactor));
      for (let i = 0; i < steps; i++) {
        this.scene.step?.(this.engine);
        Matter.Engine.update(this.engine, STEP_MS);
        this.scene.onStep?.(this.engine);
        this.motion.update();
        for (const fn of this.stepListeners) fn(this.engine);
      }
      for (const fn of this.frameListeners) fn();
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.morphStart = null;
    Matter.World.clear(this.engine.world, false);
    Matter.Engine.clear(this.engine);
  }

  /** One frame. `morphT` = morph progress 0..1 while the morph plays. */
  private draw(morphT?: number) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const view = viewOf(this.scene);
    const cssH = pictureCssHeight(view, this.worldW, this.photoH, cssW);
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    }
    const { S: s, tx, ty } = pictureTransform(view, this.worldW, canvas.width, canvas.height, this.photoH);
    const drawn = this.drawn;
    if (view || drawn || ty > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = PAPER_FILL;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(s, 0, 0, s, tx, ty);
    const px = (window.devicePixelRatio || 1) / s; // world px per CSS px
    if (drawn && morphT !== undefined) drawMorph({ ctx, scene: this.scene, drawn: drawn.fixed, moving: drawn.moving, px, t: morphT, intro: this.intro });
    else if (drawn) {
      // The original drawing stays faint and still; the clean figure moves on top of it. The ghost of the moving
      // parts fades away after the morph (and is not shown at all on a rebuild).
      ctx.globalAlpha = FAINT_ALPHA;
      ctx.drawImage(drawn.fixed, 0, 0);
      const ghost = ghostAlpha(this.morphEnd === null ? null : performance.now() - this.morphEnd);
      if (ghost > 0) {
        ctx.globalAlpha = ghost;
        ctx.drawImage(drawn.moving, 0, 0);
      }
      ctx.globalAlpha = 1;
      if (this.scene.onDraw) {
        ctx.save();
        this.scene.onDraw(ctx);
        ctx.restore();
      }
      drawClean(ctx, this.scene.clean!, px);
    } else {
      ctx.drawImage(this.scene.background, 0, 0);
      if (this.scene.onDraw) {
        ctx.save();
        this.scene.onDraw(ctx);
        ctx.restore();
      }
      if (this.scene.drawnOnly) {
        ctx.save();
        this.scene.drawnOnly(ctx);
        ctx.restore();
      }
      for (const sp of this.scene.sprites) drawSprite(ctx, sp);
    }
    for (const fn of this.drawListeners) {
      ctx.save();
      // Value labels and arrows fade in at the end of the morph.
      if (morphT !== undefined) ctx.globalAlpha = morphLabelAlpha(morphT);
      fn(ctx, this.scene, s);
      ctx.restore();
    }
    if (DEBUG) this.drawDebug();
  }

  private drawDebug() {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,0,80,0.8)';
    ctx.lineWidth = 2;
    for (const b of Matter.Composite.allBodies(this.engine.world)) {
      ctx.beginPath();
      b.vertices.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)));
      ctx.closePath();
      ctx.stroke();
    }
    for (const c of Matter.Composite.allConstraints(this.engine.world)) {
      const a = Matter.Constraint.pointAWorld(c);
      const b = Matter.Constraint.pointBWorld(c);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}

export function drawSprite(ctx: CanvasRenderingContext2D, sp: Sprite) {
  const f = sp.follow;
  ctx.save();
  if (f.kind === 'body') {
    ctx.translate(f.body.position.x, f.body.position.y);
    ctx.rotate(f.body.angle - f.originAngle);
    ctx.translate(-f.origin.x, -f.origin.y);
  } else if (f.kind === 'stretch') {
    const end = Matter.Constraint.pointBWorld(f.constraint);
    const a = f.anchor;
    const a0 = Math.atan2(f.origin.y - a.y, f.origin.x - a.x);
    const l0 = Math.max(1, Math.hypot(f.origin.x - a.x, f.origin.y - a.y));
    ctx.translate(a.x, a.y);
    ctx.rotate(Math.atan2(end.y - a.y, end.x - a.x));
    ctx.scale(Math.hypot(end.x - a.x, end.y - a.y) / l0, 1);
    ctx.rotate(-a0);
    ctx.translate(-a.x, -a.y);
  } else {
    const p = f.body.position;
    const ang = Math.atan2(p.y - f.pivot.y, p.x - f.pivot.x);
    ctx.translate(f.pivot.x, f.pivot.y);
    ctx.rotate(ang - f.originAngle);
    ctx.translate(-f.pivot.x, -f.pivot.y);
  }
  ctx.drawImage(sp.image, sp.offset.x, sp.offset.y);
  ctx.restore();
}
