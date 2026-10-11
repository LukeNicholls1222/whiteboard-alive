// Pendulum view (camera): the picture always shows the whole swing.
//
// A bob drawn near the paper's edge, a wide swing, or a swing that grows when gravity drops (Moon mode keeps the
// speed, so the bob climbs higher) can carry the bob past the photo's edges. The scene gives sim.ts a view (BuiltScene
// .view) worked out from the swing's full range, never from where the bob is right now, so the camera never follows
// the bob around:
//   - the range comes from the energy of the state now, E/(gL) = ω²L/(2g) + (1 − cos θ): the bob turns back where
//     1 − cos θmax = E/(gL) (it goes over the top when that is ≥ 2 or gravity is off);
//   - the box holds the pivot and the bob's disc at every angle of that range;
//   - around the box the picture keeps room measured in CSS px (Insets): EDGE_CSS from every edge, and at the top the
//     row of buttons floating over the picture (the speed badge, "Show what AI saw") plus EDGE_CSS, so the bob never
//     slides behind them. World px per CSS px = view width / canvas CSS width (the DPR cancels out);
//   - while the box with that room lies inside the photo the view is the photo itself (null). Otherwise the view is
//     the smallest rect of the photo's own shape (height / width) that holds the box with its room, never narrower
//     than the photo, so the picture's CSS height never changes (the pills under it stay put while a value is being
//     changed). Where it is: zoomed out, the box sits in the middle of the room (a full turn has the pivot near the
//     centre; paper colour fills what lies outside the photo); not zoomed (the box fits the photo's width but is
//     too close to an edge), the photo is slid just far enough. The two blend over the first ZOOM_BLEND of zoom;
//   - the view shown eases towards that target (exponential, settled in about half a second) so a gravity change glides.
// Pure functions (no imports beyond types): tests/pendulum-view.test.ts runs them in node.

import type { Point, ViewRect } from '../types';

/** Time constant of the easing (s): 95 % of the way in 3τ = 0.3 s, settled (within half a px) by about 0.6 s. */
export const VIEW_TAU_S = 0.1;
/** Room between the bob's disc (at the ends of the swing) and the picture's edges or the buttons over it, CSS px. */
export const EDGE_CSS = 20;
/** Height of the row of buttons over the picture's top edge when it cannot be measured (CSS px, from its top edge). */
export const TOP_ROW_FALLBACK_CSS = 46;
/** Zoom (as a share of the photo's width) over which the placing blends from "slide the photo" to "centre the box". */
export const ZOOM_BLEND = 0.15;

/** Room kept clear around the swing box, CSS px of the picture, per edge. */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ViewSpec {
  photoW: number;
  photoH: number;
  /** Width of the picture on screen, CSS px (the canvas's clientWidth). */
  cssW: number;
  insets: Insets;
  /** What sim.ts allows for a view's height / width. */
  bounds: AspectBounds;
}

export interface SwingGeometry {
  pivot: Point;
  /** Pivot to bob centre, world px. */
  length: number;
  bobRadius: number;
}

/**
 * Half-angle of the swing (rad, 0..π) from the state now: the angle where the bob turns back, from its energy.
 * `omega` in rad per step, `g` in px per step² (like the scene's own integration). π = goes over the top.
 */
export function swingAmplitude(length: number, theta: number, omega: number, g: number): number {
  if (!(g > 1e-12) || !(length > 0)) return Math.PI;
  const u = (omega * omega * length) / (2 * g) + (1 - Math.cos(theta));
  if (u >= 2) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, 1 - u)));
}

/** Box (world px) around the pivot and every place the bob's disc can be in a swing of ±amp, plus `margin` (world px). */
export function swingBox(geo: SwingGeometry, amp: number, margin = 0): ViewRect {
  const { pivot: P, length: L, bobRadius: r } = geo;
  const a = Math.max(0, Math.min(Math.PI, amp));
  // Widest at 90° (or the ends of a smaller swing); lowest straight down (always passed); highest at the ends past 90°.
  const sx = a >= Math.PI / 2 ? L : L * Math.sin(a);
  const top = a >= Math.PI ? P.y - L : Math.min(P.y, P.y + L * Math.cos(a));
  const e = r + margin;
  const x0 = P.x - sx - e, y0 = top - e;
  return { x: x0, y: y0, w: 2 * (sx + e), h: P.y + L + e - y0 };
}

export function unionRect(a: ViewRect, b: ViewRect): ViewRect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export const containsRect = (outer: ViewRect, inner: ViewRect, tol = 0): boolean =>
  inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;

/** Smallest rectangle of shape `aspect` (= h / w) around `box`, grown the same amount on both sides. */
export function fitAspect(box: ViewRect, aspect: number): ViewRect {
  if (box.h > aspect * box.w) {
    const w = box.h / aspect;
    return { x: box.x - (w - box.w) / 2, y: box.y, w, h: box.h };
  }
  const h = aspect * box.w;
  return { x: box.x, y: box.y - (h - box.h) / 2, w: box.w, h };
}

export interface AspectBounds {
  min: number;
  max: number;
}

/** The part of a view (world px) the swing box may use: the view less its insets (CSS px × world px per CSS px). */
export function roomOf(view: ViewRect, insets: Insets, cssW: number): ViewRect {
  const k = view.w / cssW;
  return {
    x: view.x + insets.left * k,
    y: view.y + insets.top * k,
    w: view.w - (insets.left + insets.right) * k,
    h: view.h - (insets.top + insets.bottom) * k,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The view the picture should show for a swing box: null while the box, with its room, fits the photo as it is;
 * else the smallest rect of the photo's shape (clamped to what sim.ts allows; never narrower than the photo, so the
 * picture only ever zooms out) whose room holds the box. Zoomed out, the box is centred in the room; not zoomed,
 * the photo is slid just as far as the room needs (blended over the first ZOOM_BLEND of zoom, so nothing jumps).
 */
export function pendulumTarget(spec: ViewSpec, box: ViewRect): ViewRect | null {
  const { photoW, photoH, cssW, insets, bounds } = spec;
  const photo = { x: 0, y: 0, w: photoW, h: photoH };
  if (containsRect(roomOf(photo, insets, cssW), box, 1e-6)) return null;
  const aspect = clamp(photoH / photoW, bounds.min, bounds.max);
  // Room as a share of the view: width 1 − (left + right) / cssW, height aspect − (top + bottom) / cssW.
  const fx = Math.max(0.05, 1 - (insets.left + insets.right) / cssW);
  const fy = Math.max(0.05, aspect - (insets.top + insets.bottom) / cssW);
  const needed = Math.max(box.w / fx, box.h / fy);
  const w = Math.max(needed, photoW), h = aspect * w, k = w / cssW;
  // Where the view's x may lie so its room holds the box (likewise y); with w = needed the range is one point.
  const xMin = box.x + box.w + insets.right * k - w, xMax = box.x - insets.left * k;
  const yMin = box.y + box.h + insets.bottom * k - h, yMax = box.y - insets.top * k;
  const slid = { x: clamp(0, xMin, xMax), y: clamp(0, yMin, yMax) };
  const centred = { x: (xMin + xMax) / 2, y: (yMin + yMax) / 2 };
  const z = clamp((needed / photoW - 1) / ZOOM_BLEND, 0, 1);
  return { x: slid.x + (centred.x - slid.x) * z, y: slid.y + (centred.y - slid.y) * z, w, h };
}

/** One easing step: `shown` moved towards `target` for `dt` seconds (exponential, time constant `tau`). */
export function easeRect(shown: ViewRect, target: ViewRect, dt: number, tau = VIEW_TAU_S): ViewRect {
  const k = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau);
  return {
    x: shown.x + (target.x - shown.x) * k,
    y: shown.y + (target.y - shown.y) * k,
    w: shown.w + (target.w - shown.w) * k,
    h: shown.h + (target.h - shown.h) * k,
  };
}

const near = (a: ViewRect, b: ViewRect, tol: number) =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;

/**
 * The view as shown, easing towards whatever target it is given: a rect, or null for the photo. The first call shows
 * its target at once (a new scene opens on the right picture); the view is null again once it is back on the photo.
 * `read(target, t)` may be called several times a frame (renderer, overlay, labels): it only moves when `t` advances.
 */
export class SmoothView {
  private shown: ViewRect | null = null;
  private lastT: number | null = null;
  private readonly photoW: number;
  private readonly photoH: number;
  private readonly tau: number;

  constructor(photoW: number, photoH: number, tau = VIEW_TAU_S) {
    this.photoW = photoW;
    this.photoH = photoH;
    this.tau = tau;
  }

  /** `t` in seconds (any clock that only moves forward). */
  read(target: ViewRect | null, t: number): ViewRect | null {
    const photo = { x: 0, y: 0, w: this.photoW, h: this.photoH };
    const want = target ?? photo;
    if (this.shown === null || this.lastT === null) {
      this.shown = { ...want };
      this.lastT = t;
    } else if (t > this.lastT) {
      this.shown = easeRect(this.shown, want, Math.min(0.25, t - this.lastT), this.tau);
      this.lastT = t;
    }
    // Settled (within half a px): snap, so a view that went back to the photo is the photo again.
    if (near(this.shown, want, 0.5)) this.shown = { ...want };
    return target === null && near(this.shown, photo, 0) ? null : this.shown;
  }
}
