// "What the AI saw": the detected contours drawn over the original drawing, coloured by role.
// Shown for ~1.5 s before the simulation starts, then on demand via a toggle button.

import type { Analysis, BodyRole, BuiltScene, Contour, Point } from './types';

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
  wheel: { label: 'pulley', color: C.purple },
  cannon: { label: 'cannon', color: C.red },
  arrow: { label: 'arrow', color: C.red },
  projectile: { label: 'ball', color: C.orange },
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
const FADE_MS = 450;

export class AIOverlay {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private runs: Run[] = [];
  private labels: Label[] = [];
  private data: OverlayInput | null = null;
  private raf = 0;
  private visible = false;
  private intro = false;
  private token = 0;

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
    this.canvas.classList.remove('show', 'intro', 'fade');
    this.button.hidden = true;
  }

  /** Full-opacity intro over the paper; resolves when the simulation should start (overlay keeps fading out on top). */
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
    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = performance.now() - t0;
        this.draw(Math.min(1, t / (INTRO_MS * 0.6)), true);
        if (token !== this.token || t >= INTRO_MS) return resolve();
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    });
    if (token !== this.token) return;
    // Fade out while the simulation starts underneath.
    this.canvas.classList.add('fade');
    setTimeout(() => {
      if (token !== this.token) return;
      this.intro = false;
      this.canvas.classList.remove('intro', 'fade', 'show');
      this.button.hidden = false;
      this.syncButton();
    }, FADE_MS);
  }

  setVisible(v: boolean) {
    if (!this.data || this.intro) return;
    this.visible = v;
    this.canvas.classList.toggle('show', v);
    this.syncButton();
    if (v) this.redraw();
  }

  private syncButton() {
    this.button.textContent = this.visible ? 'Hide what AI saw' : 'Show what AI saw';
    this.button.classList.toggle('on', this.visible);
  }

  private redraw() {
    if (this.data && this.visible && !this.intro) this.draw(1, false);
  }

  /** Make sure the stage has its final height before the simulation's first frame. */
  private sizeStage() {
    const d = this.data!;
    const cssW = this.stage.clientWidth;
    this.stage.style.height = `${(cssW * d.height) / d.width}px`;
  }

  private classify(input: OverlayInput) {
    this.runs = [];
    this.labels = [];
    const roles = new Map(input.analysis.bodies.map((b) => [b.contourId, b]));
    if (roles.size) {
      for (const k of input.contours) {
        if (k.points.length < 2) continue;
        const body = roles.get(k.id);
        const style = body ? ROLE_STYLE[body.role] : null;
        this.runs.push({ points: k.points, closed: true, color: style?.color ?? C.grey });
        if (style && body!.role !== 'other') this.labels.push({ text: style.label, color: style.color, at: labelPoint(k.points) });
      }
      return;
    }
    // No AI roles: what moves is whatever the scene cut out into sprites; the rest stays in the background.
    const moving = spriteHitTest(input.scene);
    for (const k of input.contours) {
      if (k.points.length < 2) continue;
      const pts = densify(k.points, 6);
      const flags = pts.map(moving);
      // Split the closed outline into runs of equal kind.
      let start = flags.findIndex((f, i) => f !== flags[(i + flags.length - 1) % flags.length]);
      if (start < 0) {
        const s = flags[0] ? MOVING : FIXED;
        this.runs.push({ points: k.points, closed: true, color: s.color });
        this.labels.push({ text: s.label, color: s.color, at: labelPoint(k.points) });
        continue;
      }
      const n = pts.length;
      const best: Record<string, Point[]> = {};
      let cur: Point[] = [];
      for (let j = 0; j <= n; j++) {
        const i = (start + j) % n;
        const p = pts[i];
        if (j > 0 && (j === n || flags[i] !== flags[(i + n - 1) % n])) {
          cur.push(p);
          const f = flags[(i + n - 1) % n];
          const s = f ? MOVING : FIXED;
          this.runs.push({ points: cur, closed: false, color: s.color });
          if (!best[s.label] || cur.length > best[s.label].length) best[s.label] = cur;
          cur = [];
        }
        cur.push(p);
      }
      for (const s of [MOVING, FIXED])
        if (best[s.label] && best[s.label].length >= 4)
          this.labels.push({ text: s.label, color: s.color, at: best[s.label][Math.floor(best[s.label].length / 2)] });
    }
  }

  /** progress 0..1 traces the lines in; withPaper paints the original drawing underneath. */
  private draw(progress: number, withPaper: boolean) {
    const d = this.data;
    if (!d) return;
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.stage.clientWidth || canvas.clientWidth;
    const cssH = (cssW * d.height) / d.width;
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    canvas.style.height = `${cssH}px`;
    const s = canvas.width / d.width;
    const px = d.width / cssW; // world units per CSS pixel
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (withPaper) {
      ctx.drawImage(d.paper, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(0, 0, d.width, d.height);
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 7 * px;
    ctx.globalAlpha = 0.55;
    for (const r of this.runs) {
      ctx.strokeStyle = r.color;
      strokePartial(ctx, r.points, r.closed, progress);
    }
    ctx.globalAlpha = 1;

    // Labels pop in after the lines are mostly traced.
    const la = withPaper ? clamp01((progress - 0.5) / 0.5) : 1;
    if (la <= 0) return;
    const font = 12 * px;
    ctx.font = `800 ${font}px Nunito, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const l of this.labels) {
      const w = ctx.measureText(l.text).width + 14 * px;
      const h = 22 * px;
      let x = Math.min(d.width - w - 4 * px, Math.max(4 * px, l.at.x - w / 2));
      let y = Math.min(d.height - h - 4 * px, Math.max(4 * px, l.at.y - h / 2));
      for (let tries = 0; tries < 8 && placed.some((b) => overlap(b, { x, y, w, h })); tries++) {
        y = Math.min(d.height - h - 4 * px, y + h + 3 * px);
      }
      placed.push({ x, y, w, h });
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

/** Returns a test "is this drawn point part of something that moves?" from the sprites' cut-out alpha. */
function spriteHitTest(scene: BuiltScene): (p: Point) => boolean {
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
    maps.some((m) => {
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

/** Top-most point of the outline, so the label sits on the stroke rather than in empty space. */
function labelPoint(pts: Point[]): Point {
  let best = pts[0];
  for (const p of pts) if (p.y < best.y) best = p;
  return best;
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
