// "What the AI saw": the detected contours drawn over the original drawing, coloured by role.
// Shown for ~1.5 s before the simulation starts, then on demand via a toggle button. Its last frame is handed to the
// morph (morph.ts IntroLayer), which draws the same picture as its first frame and absorbs the colours into its
// lights, so the overlay can be hidden at once with no frame of the plain drawing in between.

import type { Analysis, BodyRole, BuiltScene, Contour, Point, Sprite } from './types';
import { contourMask, deepestPoint, maskBounds } from './scenes/common';
import { type IntroLayer, MORPH_MS } from './morph';
import { drawSprite, PAPER_FILL, pictureCssHeight, pictureTransform, viewOf, visibleRect } from './sim';

const C = {
  green: '#58cc02',
  blue: '#1cb0f6',
  orange: '#ff9600',
  red: '#ff4b4b',
  purple: '#ce82ff',
  grey: '#afafaf',
};

const ROLE_STYLE: Record<BodyRole, { label: string; color: string }> = {
  pivot: { label: 'pivot', color: C.green },
  rope: { label: 'string', color: C.blue },
  bob: { label: 'bob', color: C.orange },
  spring: { label: 'spring', color: C.purple },
  mass: { label: 'block', color: C.orange },
  incline: { label: 'ramp', color: C.green },
  ground: { label: 'ground', color: C.green },
  wheel: { label: 'wheel', color: C.purple },
  cannon: { label: 'cannon', color: C.red },
  arrow: { label: 'arrow', color: C.red },
  projectile: { label: 'ball', color: C.orange },
  label: { label: 'note', color: C.grey },
  other: { label: 'other', color: C.grey },
};
const MOVING = { label: 'moving', color: C.orange };
const FIXED = { label: 'fixed', color: C.blue };

interface Run {
  points: Point[];
  closed: boolean;
  color: string;
}
interface Label {
  text: string;
  color: string;
  at: Point;
}

export interface OverlayInput {
  width: number;
  height: number;
  paper: HTMLCanvasElement;
  contours: Contour[];
  analysis: Analysis;
  scene: BuiltScene;
}

const INTRO_MS = 1500;
/** Fade-out when there is no morph to hand over to (drawn style). */
const FADE_MS = 450;
/** How the lines are drawn (the morph keeps drawing them the same way). */
const WASH = 0.35;
const RUN_ALPHA = 0.55;
const RUN_CSS = 7;

export class AIOverlay {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private runs: Run[] = [];
  private labels: Label[] = [];
  /** Where the labels were drawn last (world px), for the hand-over to the morph. */
  private placed: IntroLayer['labels'] = [];
  private data: OverlayInput | null = null;
  private raf = 0;
  private visible = false;
  private intro = false;
  private token = 0;
  /** The view the overlay was last drawn for, and the loop that follows a live one. */
  private shownView = '';
  private viewRaf = 0;

  constructor(
    private stage: HTMLCanvasElement,
    private button: HTMLButtonElement,
  ) {
    this.canvas.className = 'ai-overlay';
    stage.parentElement!.appendChild(this.canvas);
    button.addEventListener('click', () => this.setVisible(!this.visible));
    window.addEventListener('resize', () => this.redraw());
  }

  /** Prepare for a new photo: hide everything and drop the old result. */
  reset() {
    this.token++;
    cancelAnimationFrame(this.raf);
    this.data = null;
    this.intro = false;
    this.visible = false;
    this.canvas.classList.remove('show', 'intro', 'fade', 'off');
    this.button.hidden = true;
  }

  /**
   * Full-opacity intro over the paper; resolves when the simulation should start. The overlay stays on screen, as
   * it is, until release(): the caller starts the simulation (its first morph frame is this same picture) and then
   * releases it, so nothing else is ever seen in between.
   */
  async playIntro(input: OverlayInput): Promise<void> {
    this.reset();
    const token = ++this.token;
    this.data = input;
    this.classify(input);
    try {
      await Promise.race([document.fonts.load('800 12px Nunito'), wait(300)]);
    } catch {
      /* font is optional */
    }
    if (token !== this.token) return;
    this.intro = true;
    this.sizeStage();
    this.canvas.classList.add('show', 'intro');
    const t0 = performance.now();
    if (import.meta.env.DEV && (window as any).__wa) (window as any).__wa.introStart = t0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = performance.now() - t0;
        this.draw(Math.min(1, t / (INTRO_MS * 0.6)), true);
        if (token !== this.token || t >= INTRO_MS) return resolve();
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /** The intro's last frame for the morph to carry on from (null when no intro is on screen). */
  handoff(): IntroLayer | null {
    if (!this.intro || !this.data) return null;
    return { wash: WASH, runs: this.runs, runAlpha: RUN_ALPHA, runCss: RUN_CSS, labels: this.placed };
  }

  /**
   * End the intro. `morphing`: the simulation is drawing the morph from the handed-over picture, so the overlay goes
   * away at once (no transition) and the toggle shows once the morph is over. Otherwise (drawn style, no morph) it
   * fades out over the plain drawing as before.
   */
  release(morphing: boolean) {
    if (!this.intro) return;
    const token = this.token;
    this.canvas.classList.add(morphing ? 'off' : 'fade');
    setTimeout(() => {
      if (token !== this.token) return;
      this.intro = false;
      this.canvas.classList.remove('intro', 'fade', 'show', 'off');
      this.button.hidden = false;
      this.syncButton();
    }, morphing ? MORPH_MS : FADE_MS);
  }

  /**
   * The scene was rebuilt for the same photo (a typed number, the launch speed). Only when the drawing itself moved
   * on screen (a ramp stretched to an entered angle) or the picture shows a different part of the world (a view, now
   * or before) are the outlines worked out again, so they sit on the drawing.
   */
  setScene(scene: BuiltScene) {
    const d = this.data;
    const moves = (s: BuiltScene) => !!s.drawnAt || !!s.view;
    if (!d || d.scene === scene || (!moves(scene) && !moves(d.scene))) return;
    this.data = { ...d, scene };
    this.classify(this.data);
    this.redraw();
    if (this.visible) this.watchView();
  }

  setVisible(v: boolean) {
    if (!this.data || this.intro) return;
    this.visible = v;
    this.canvas.classList.toggle('show', v);
    this.syncButton();
    if (v) {
      this.redraw();
      this.watchView();
    }
  }

  private syncButton() {
    this.button.textContent = this.visible ? 'Hide what AI saw' : 'Show what AI saw';
    this.button.classList.toggle('on', this.visible);
  }

  private redraw() {
    if (this.data && this.visible && !this.intro) this.draw(1, false);
  }

  /** While shown over a scene whose view follows live values (gravity), redraw when the view changes. */
  private watchView() {
    cancelAnimationFrame(this.viewRaf);
    const tick = () => {
      const d = this.data;
      if (!d || !this.visible || typeof d.scene.view !== 'function') return;
      const v = viewOf(d.scene);
      const key = v ? `${v.x},${v.y},${v.w},${v.h}` : '';
      if (key !== this.shownView && !this.intro) this.redraw();
      this.viewRaf = requestAnimationFrame(tick);
    };
    this.viewRaf = requestAnimationFrame(tick);
  }

  /** Make sure the stage has its final height before the simulation's first frame. */
  private sizeStage() {
    const d = this.data!;
    const cssW = this.stage.clientWidth;
    this.stage.style.height = `${pictureCssHeight(viewOf(d.scene), d.width, d.height, cssW)}px`;
  }

  /**
   * Colour every outline point by the part of the drawing it belongs to. One contour often holds several
   * parts (ceiling + string + bob drawn touching), so outlines are split into runs, not coloured whole.
   */
  private classify(input: OverlayInput) {
    this.runs = [];
    this.labels = [];
    const { parts, partOf: scenePartOf } = partsFor(input);
    // Handwritten values were read, not simulated: show them as notes whatever the scene made of the rest.
    const notes = new Set(input.analysis.bodies.filter((b) => b.role === 'label').map((b) => b.contourId));
    if (notes.size) parts.note = style(ROLE_STYLE.label);
    const partOf = (p: Point, k: Contour) => (notes.has(k.id) ? 'note' : scenePartOf(p, k));
    const best = new Map<string, Point[]>(); // longest run per part, for label placement
    const note = (key: string, run: Point[]) => {
      const b = best.get(key);
      if (!b || run.length > b.length) best.set(key, run);
    };
    for (const k of input.contours) {
      if (k.points.length < 2) continue;
      const pts = densify(k.points, 6);
      const keys = pts.map((p) => partOf(p, k));
      const n = pts.length;
      const start = keys.findIndex((f, i) => f !== keys[(i + n - 1) % n]);
      if (start < 0) {
        this.runs.push({ points: k.points, closed: true, color: parts[keys[0]].color });
        note(keys[0], pts);
        continue;
      }
      let cur: Point[] = [];
      for (let j = 0; j <= n; j++) {
        const i = (start + j) % n;
        const p = pts[i];
        if (j > 0 && (j === n || keys[i] !== keys[(i + n - 1) % n])) {
          cur.push(p);
          const key = keys[(i + n - 1) % n];
          this.runs.push({ points: cur, closed: false, color: parts[key].color });
          note(key, cur);
          cur = [];
        }
        cur.push(p);
      }
    }
    for (const [key, part] of Object.entries(parts)) {
      if (!part.text) continue;
      const run = best.get(key);
      if (!run) continue; // part not in the drawing
      if (!part.anchor && run.length < 4) continue;
      this.labels.push({ text: part.text, color: part.color, at: part.anchor ?? run[Math.floor(run.length / 2)] });
    }
    // A scene that moved the drawing (stretched ramp) says where each drawn point is shown now.
    const at = input.scene.drawnAt;
    if (at) {
      for (const r of this.runs) r.points = r.points.map(at);
      for (const l of this.labels) l.at = at(l.at);
    }
  }

  /** progress 0..1 traces the lines in; withPaper paints the original drawing underneath. */
  private draw(progress: number, withPaper: boolean) {
    const d = this.data;
    if (!d) return;
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.stage.clientWidth || canvas.clientWidth;
    // Same picture as the simulation: the photo, or the scene's view (a stretched ramp, a long shot).
    const view = viewOf(d.scene);
    this.shownView = view ? `${view.x},${view.y},${view.w},${view.h}` : '';
    const cssH = pictureCssHeight(view, d.width, d.height, cssW);
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    canvas.style.height = `${cssH}px`;
    const { S: s, tx, ty } = pictureTransform(view, d.width, canvas.width, canvas.height);
    const px = dpr / s; // world units per CSS pixel
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (withPaper && view) {
      ctx.fillStyle = PAPER_FILL;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(s, 0, 0, s, tx, ty);
    const vis = visibleRect(ctx);
    if (withPaper) {
      if (d.scene.drawnAt) {
        // The drawing as the scene shows it at the start (stretched ramp, blocks on it), not as photographed.
        ctx.drawImage(d.scene.background, 0, 0);
        for (const sp of d.scene.sprites) drawSprite(ctx, sp);
      } else ctx.drawImage(d.paper, 0, 0);
      ctx.fillStyle = `rgba(255,255,255,${WASH})`;
      ctx.fillRect(vis.x, vis.y, vis.w, vis.h);
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = RUN_CSS * px;
    ctx.globalAlpha = RUN_ALPHA;
    for (const r of this.runs) {
      ctx.strokeStyle = r.color;
      strokePartial(ctx, r.points, r.closed, progress);
    }
    ctx.globalAlpha = 1;

    // Labels pop in after the lines are mostly traced.
    const la = withPaper ? clamp01((progress - 0.5) / 0.5) : 1;
    this.placed = [];
    if (la <= 0) return;
    const font = 12 * px;
    ctx.font = `800 ${font}px Nunito, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const l of this.labels) {
      const w = ctx.measureText(l.text).width + 14 * px;
      const h = 22 * px;
      // Centred on the part; if another label is already there, nudge it up/down/sideways a little.
      const dy = h + 3 * px, dx = w * 0.6;
      const tries = [[0, 0], [0, -dy], [0, dy], [dx, 0], [-dx, 0], [dx, -dy], [-dx, -dy], [dx, dy], [-dx, dy], [0, -2 * dy], [0, 2 * dy]];
      let x = 0, y = 0;
      for (const [ox, oy] of tries) {
        x = Math.min(vis.x + vis.w - w - 4 * px, Math.max(vis.x + 4 * px, l.at.x + ox - w / 2));
        y = Math.min(vis.y + vis.h - h - 4 * px, Math.max(vis.y + 4 * px, l.at.y + oy - h / 2));
        if (!placed.some((b) => overlap(b, { x, y, w, h }))) break;
      }
      placed.push({ x, y, w, h });
      this.placed.push({ text: l.text, color: l.color, x, y, w, h });
      ctx.globalAlpha = la;
      const pop = 0.8 + 0.2 * la;
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.scale(pop, pop);
      ctx.fillStyle = l.color;
      roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
      ctx.fill();
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(l.text, 0, 1 * px);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

interface Part {
  /** Label text; empty = coloured but not labelled. */
  text: string;
  color: string;
  /** Where the label goes; default = middle of the part's longest outline run. */
  anchor?: Point;
}
interface PartMap {
  parts: Record<string, Part>;
  partOf: (p: Point, k: Contour) => string;
}

const style = (s: { label: string; color: string }, anchor?: Point): Part => ({ text: s.label, color: s.color, anchor });
const center = (sp: Sprite): Point => ({ x: sp.offset.x + sp.image.width / 2, y: sp.offset.y + sp.image.height / 2 });
const bodyHome = (sp: Sprite): Point => (sp.follow.kind === 'body' ? sp.follow.origin : center(sp));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Parts of the drawing per diagram, from what the scene builder actually did: the sprites are what moves
 * (and how: body / swing / stretch), everything else is the static background.
 */
function partsFor(input: OverlayInput): PartMap {
  const { scene } = input;
  const hit = spriteHitTest(scene);
  switch (scene.label) {
    case 'Pendulum': {
      const sp = scene.sprites.find((s) => s.follow.kind === 'swing');
      if (!sp || sp.follow.kind !== 'swing') break;
      const f = sp.follow;
      const bob = { x: f.pivot.x + Math.cos(f.originAngle) * f.originLength, y: f.pivot.y + Math.sin(f.originAngle) * f.originLength };
      const r = f.body.circleRadius ?? 12;
      return {
        parts: {
          pivot: style(ROLE_STYLE.pivot, f.pivot),
          string: style(ROLE_STYLE.rope, { x: (f.pivot.x + bob.x) / 2, y: (f.pivot.y + bob.y) / 2 }),
          bob: style(ROLE_STYLE.bob, bob),
        },
        partOf: (p) => (hit(p) < 0 ? 'pivot' : dist(p, bob) <= r * 1.5 + 6 ? 'bob' : 'string'),
      };
    }
    case 'Spring and mass': {
      const blockSp = scene.sprites.find((s) => s.follow.kind === 'body');
      const springSp = scene.sprites.find((s) => s.follow.kind === 'stretch');
      const c = scene.constraints[0];
      const anchor = springSp?.follow.kind === 'stretch' ? springSp.follow.anchor : c?.pointA && !c.bodyA ? c.pointA : null;
      const block = blockSp ? bodyHome(blockSp) : null;
      // Which side the spring hangs from decides the name of the fixed part.
      const vertical = anchor && block ? Math.abs(block.y - anchor.y) >= Math.abs(block.x - anchor.x) : true;
      const fixedName = vertical ? 'ceiling' : 'wall';
      const out = anchor && block ? { x: anchor.x - block.x, y: anchor.y - block.y } : { x: 0, y: -1 };
      const ol = Math.hypot(out.x, out.y) || 1;
      const parts: Record<string, Part> = {
        fixed: { text: fixedName, color: C.green, anchor: anchor ? { x: anchor.x + (out.x / ol) * 16, y: anchor.y + (out.y / ol) * 16 } : undefined },
        spring: style(ROLE_STYLE.spring, springSp ? center(springSp) : anchor && block ? { x: (anchor.x + block.x) / 2, y: (anchor.y + block.y) / 2 } : undefined),
        block: style(ROLE_STYLE.mass, block ?? undefined),
      };
      return {
        parts,
        partOf: (p) => {
          const i = hit(p);
          if (i >= 0) return scene.sprites[i].follow.kind === 'stretch' ? 'spring' : 'block';
          // Spring left in the background (no cut-out): ink along the anchor -> block line, past the wall.
          if (!springSp && anchor && block) {
            const dx = block.x - anchor.x, dy = block.y - anchor.y, l2 = dx * dx + dy * dy || 1;
            const t = ((p.x - anchor.x) * dx + (p.y - anchor.y) * dy) / l2;
            const off = Math.abs((p.x - anchor.x) * dy - (p.y - anchor.y) * dx) / Math.sqrt(l2);
            if (t * Math.sqrt(l2) > 12 && t < 1 && off < 30) return 'spring';
          }
          return 'fixed';
        },
      };
    }
    case 'Incline': {
      const parts: Record<string, Part> = { ramp: style(ROLE_STYLE.incline) };
      scene.sprites.forEach((sp, i) => (parts[`block${i}`] = style(ROLE_STYLE.mass, bodyHome(sp))));
      return { parts, partOf: (p) => (hit(p) < 0 ? 'ramp' : `block${hit(p)}`) };
    }
    case 'Pulley': {
      const { center: C0, radius: R } = findWheel(input);
      const parts: Record<string, Part> = {
        pulley: { text: 'pulley', color: C.purple, anchor: C0 },
        rope: { text: 'rope', color: C.blue },
        ground: style(ROLE_STYLE.ground),
      };
      scene.sprites.forEach((sp, i) => (parts[`weight${i}`] = { text: 'weight', color: C.orange, anchor: bodyHome(sp) }));
      const bottom = Math.max(...scene.sprites.map((s) => s.offset.y + s.image.height));
      return {
        parts,
        partOf: (p) => {
          const i = hit(p);
          if (i >= 0) return `weight${i}`;
          if (dist(p, C0) <= R * 1.35 + 4 || p.y < C0.y - R) return 'pulley'; // wheel and what holds it up
          if (scene.sprites.length && p.y > bottom + 8) return 'ground';
          return 'rope';
        },
      };
    }
    case 'Projectile': {
      const ballSp = scene.sprites[0];
      const roles = new Map(input.analysis.bodies.map((b) => [b.contourId, b.role]));
      // The safety floor sits on the drawn ground line (or the photo's bottom if none was drawn).
      const floor = scene.bodies.filter((b) => b.isStatic).sort((a, b) => b.bounds.max.x - b.bounds.min.x - (a.bounds.max.x - a.bounds.min.x))[0];
      const floorY = floor ? floor.bounds.min.y : input.height;
      const tol = Math.max(10, input.height * 0.025);
      // Hand-drawn ground lines tilt: fit y = a x + b to the ink near the floor, then follow that line.
      let line = { a: 0, b: floorY };
      if (floorY < input.height - 2) {
        const ink = input.contours.flatMap((k) => densify(k.points, 6)).filter((p) => hit(p) < 0);
        for (let pass = 0; pass < 3; pass++) {
          const near = ink.filter((p) => Math.abs(p.y - (line.a * p.x + line.b)) <= tol * (pass ? 1 : 1.5));
          if (near.length < 6) break;
          const mx = near.reduce((s, p) => s + p.x, 0) / near.length, my = near.reduce((s, p) => s + p.y, 0) / near.length;
          let sxy = 0, sxx = 0;
          for (const p of near) {
            sxy += (p.x - mx) * (p.y - my);
            sxx += (p.x - mx) ** 2;
          }
          const a = sxx > 0 ? Math.max(-0.2, Math.min(0.2, sxy / sxx)) : 0;
          line = { a, b: my - a * mx };
        }
      }
      const parts: Record<string, Part> = {
        ball: style(ROLE_STYLE.projectile, ballSp ? bodyHome(ballSp) : undefined),
        cannon: style(ROLE_STYLE.cannon),
        arrow: style(ROLE_STYLE.arrow),
        wheel: style(ROLE_STYLE.wheel),
        ground: style(ROLE_STYLE.ground),
        other: { text: '', color: C.grey },
      };
      const round = (k: Contour) => k.hasHole && k.bbox.w / Math.max(1, k.bbox.h) > 0.7 && k.bbox.w / Math.max(1, k.bbox.h) < 1.4;
      return {
        parts,
        partOf: (p, k) => {
          if (hit(p) >= 0) return 'ball';
          if (floorY < input.height - 2 && Math.abs(p.y - (line.a * p.x + line.b)) <= tol) return 'ground';
          const role = roles.get(k.id);
          if (role === 'arrow' || role === 'cannon' || role === 'wheel') return role;
          if (role === 'ground' || role === 'incline') return 'ground';
          if (role === 'other') return 'other';
          if (!role && round(k) && k.bbox.w < input.width * 0.2) return 'wheel';
          return k.hasHole ? 'cannon' : 'arrow';
        },
      };
    }
  }
  // Falling objects / unknown: colour by AI role per contour, else simply moving vs fixed.
  const roles = new Map(input.analysis.bodies.map((b) => [b.contourId, b.role]));
  if (roles.size) {
    const parts: Record<string, Part> = { none: { text: '', color: C.grey } };
    for (const [role, s] of Object.entries(ROLE_STYLE)) parts[role] = role === 'other' ? { text: '', color: s.color } : style(s);
    return { parts, partOf: (_p, k) => roles.get(k.id) ?? 'none' };
  }
  return { parts: { moving: style(MOVING), fixed: style(FIXED) }, partOf: (p) => (hit(p) >= 0 ? 'moving' : 'fixed') };
}

/** Same guess as the pulley scene: a round wheel stroke if it is its own contour, else the thickest ink near the top. */
function findWheel(input: OverlayInput): { center: Point; radius: number } {
  const isRound = (c: Contour) => {
    const r = c.bbox.w / Math.max(1, c.bbox.h);
    return r > 0.6 && r < 1.6;
  };
  const W = input.width, H = input.height;
  const all = contourMask({ ...input, ink: new Uint8Array(0) }, input.contours);
  const b = maskBounds(all, W, H) ?? { x: 0, y: 0, w: W, h: H };
  const byRole = input.contours.filter((c) => input.analysis.bodies.some((x) => x.contourId === c.id && x.role === 'wheel'));
  let wheel: Contour | null = null;
  if (byRole.length) {
    const best = byRole.sort((a, c) => c.area - a.area)[0];
    if (isRound(best)) wheel = best;
  } else {
    const limit = b.y + b.h * 0.55;
    wheel = input.contours
      .filter((c) => c.hasHole && isRound(c) && c.centroid.y < limit && c.bbox.w > 12)
      .sort((a, c) => a.centroid.y - c.centroid.y)[0] ?? null;
  }
  if (wheel) {
    const { x, y, w, h } = wheel.bbox;
    return { center: { x: x + w / 2, y: y + h / 2 }, radius: (w + h) / 4 };
  }
  all.fill(0, Math.max(0, Math.round(b.y + b.h * 0.45)) * W);
  const { point, radius } = deepestPoint(all, W, H);
  return { center: point, radius: Math.max(10, radius) };
}

/** Returns "which sprite (index) does this drawn point belong to, or -1" from the sprites' cut-out alpha. */
function spriteHitTest(scene: BuiltScene): (p: Point) => number {
  const maps = scene.sprites.map((sp) => {
    const w = sp.image.width, h = sp.image.height;
    let alpha: Uint8ClampedArray | null = null;
    try {
      alpha = sp.image.getContext('2d')!.getImageData(0, 0, w, h).data;
    } catch {
      /* fall back to bbox */
    }
    return { x: sp.offset.x, y: sp.offset.y, w, h, alpha };
  });
  const R = 4; // stroke margin: outline points sit just outside the ink
  return (p) =>
    maps.findIndex((m) => {
      const lx = Math.round(p.x - m.x), ly = Math.round(p.y - m.y);
      if (lx < -R || ly < -R || lx >= m.w + R || ly >= m.h + R) return false;
      if (!m.alpha) return true;
      for (let dy = -R; dy <= R; dy += 2)
        for (let dx = -R; dx <= R; dx += 2) {
          const x = lx + dx, y = ly + dy;
          if (x >= 0 && y >= 0 && x < m.w && y < m.h && m.alpha[(y * m.w + x) * 4 + 3] > 0) return true;
        }
      return false;
    });
}

/** Resample a closed outline so no two consecutive points are more than `step` px apart. */
function densify(pts: Point[], step: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = 0; j < n; j++) out.push({ x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n });
  }
  return out;
}

function strokePartial(ctx: CanvasRenderingContext2D, pts: Point[], closed: boolean, progress: number) {
  const path = closed ? [...pts, pts[0]] : pts;
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  let left = total * progress;
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length && left > 0; i++) {
    const a = path[i - 1], b = path[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg <= left) ctx.lineTo(b.x, b.y);
    else ctx.lineTo(a.x + ((b.x - a.x) * left) / seg, a.y + ((b.y - a.y) * left) / seg);
    left -= seg;
  }
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
