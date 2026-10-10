// Matter.js world + renderer that draws the hand-drawn cut-outs on top of the bodies.

import Matter from 'matter-js';
import decomp from 'poly-decomp';
import { MotionTracker } from './motion';
import type { BuiltScene, SimParams, Sprite } from './types';
import { BASE_SCALE, STEP_MS } from './units';

// The step constants live in units.ts (a leaf module); re-exported here for the scene builders.
export { STEP_ACCEL, STEP_MS } from './units';

Matter.Common.setDecomp(decomp);

export class Simulation {
  engine = Matter.Engine.create();
  private raf = 0;
  private ctx: CanvasRenderingContext2D;
  /** Smoothed velocities of the moving bodies, updated right after every step (arrows and graph share it). */
  readonly motion: MotionTracker;
  /** Called after every physics step (graphs, readouts). */
  stepListeners: Array<(engine: Matter.Engine) => void> = [];
  /** Called after every setParams, whoever made the change (slider, chip, voice, Moon switch). */
  paramListeners: Array<(p: Partial<SimParams>) => void> = [];
  /** Called every frame after the sprites, in world coordinates. `pxScale` = canvas px per world px. */
  drawListeners: Array<(ctx: CanvasRenderingContext2D, scene: BuiltScene, pxScale: number) => void> = [];

  constructor(
    private canvas: HTMLCanvasElement,
    readonly scene: BuiltScene,
    private worldW: number,
    readonly worldH: number,
  ) {
    this.ctx = canvas.getContext('2d')!;
    Matter.Composite.add(this.engine.world, [...scene.bodies, ...scene.constraints]);
    this.motion = new MotionTracker(scene);
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

  /** Current gravity in m/s² (read back from the engine, so there is one source of truth). */
  get gravity(): number {
    return (this.engine.gravity.scale / BASE_SCALE) * 9.8;
  }

  start() {
    const loop = () => {
      this.scene.step?.(this.engine);
      Matter.Engine.update(this.engine, STEP_MS);
      this.scene.onStep?.(this.engine);
      this.motion.update();
      for (const fn of this.stepListeners) fn(this.engine);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    Matter.World.clear(this.engine.world, false);
    Matter.Engine.clear(this.engine);
  }

  private draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = (cssW * this.worldH) / this.worldW;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    }
    const s = canvas.width / this.worldW;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.drawImage(this.scene.background, 0, 0);
    if (this.scene.onDraw) {
      ctx.save();
      this.scene.onDraw(ctx);
      ctx.restore();
    }
    for (const sp of this.scene.sprites) drawSprite(ctx, sp);
    for (const fn of this.drawListeners) {
      ctx.save();
      fn(ctx, this.scene, s);
      ctx.restore();
    }
    if (new URLSearchParams(location.search).has('debug')) this.drawDebug();
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

function drawSprite(ctx: CanvasRenderingContext2D, sp: Sprite) {
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
