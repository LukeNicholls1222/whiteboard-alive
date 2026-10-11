// Projectile: the clean cannon's geometry, shared by the scene (scenes/projectile.ts: where the ball starts, the
// barrel's turn to an entered angle) and the clean figure (clean.ts: how it is drawn, what the morph traces).
// A leaf module (no DOM, no Matter): tests/cannon.test.ts runs it in node.
//
// The barrel found in the ink (barrelOf) is a tube from its back end (breech) to the ball's centre (the mouth): the
// ball sits in the mouth, half in. It turns about a pivot 35 % of the way from the breech to the mouth (the trunnion,
// on the carriage), so the mouth, and with it the ball's starting point, swings on an arc about the pivot: an entered
// angle moves the launch point to where the turned barrel's mouth is. The turn is eased over AIM_MS of screen time;
// the scene keeps the ball in the mouth meanwhile and fires when the barrel has stopped.

import type { Point } from '../types';

/** The barrel (or a drawn arrow) turns to a new angle over this long, screen ms. */
export const AIM_MS = 260;
/** Where the pivot sits along the barrel, as a share of its length from the breech. */
export const PIVOT_SHARE = 0.35;

/** Screen angle (radians, clockwise on screen) of an elevation `deg` above level, towards `facing`. */
export function aimAngle(deg: number, facing: 1 | -1): number {
  const rad = (deg * Math.PI) / 180;
  return facing > 0 ? -rad : Math.PI + rad;
}

/** Unit vector of that direction. */
export function aimUnit(deg: number, facing: 1 | -1): Point {
  const a = aimAngle(deg, facing);
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** The mouth (= the ball's centre at launch) of a barrel `front` world px long from `pivot` to its mouth, at `deg`. */
export function mouthAt(pivot: Point, front: number, deg: number, facing: 1 | -1): Point {
  const u = aimUnit(deg, facing);
  return { x: pivot.x + u.x * front, y: pivot.y + u.y * front };
}

/** The barrel's turn in progress: from `from` to `to` degrees, started at screen time `at` (ms). */
export interface Aim {
  from: number;
  to: number;
  at: number;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/** Elevation shown at screen time `now`: eased from `from` to `to` over AIM_MS. */
export function aimShown(aim: Aim, now: number): number {
  const k = Math.min(1, Math.max(0, (now - aim.at) / AIM_MS));
  return aim.from + (aim.to - aim.from) * ease(k);
}

/** True while the turn is still going at screen time `now`. */
export function aiming(aim: Aim, now: number): boolean {
  return now < aim.at + AIM_MS;
}

/**
 * The turn for a scene built at screen time `now` wanting `deg`: no turn for a fresh drawing (`prev` absent: the
 * barrel is shown at that angle at once), the same turn when the angle has not changed (a rebuild for a slider), else
 * a new turn from the angle shown right now.
 */
export function aimTo(prev: Aim | undefined, deg: number, now: number): Aim {
  if (!prev) return { from: deg, to: deg, at: -Infinity };
  if (Math.abs(prev.to - deg) < 1e-9) return prev;
  return { from: aimShown(prev, now), to: deg, at: now };
}

// ---- The barrel in the ink -------------------------------------------------------------------------------

/** The drawn barrel, world px, where it was drawn (see LaunchBarrel in types.ts for the fields). */
export interface BarrelFound {
  pivot: Point;
  breech: Point;
  /** The mouth: the ball's centre. */
  muzzle: Point;
  /** Breech to mouth. */
  length: number;
  thickness: number;
}

/**
 * The drawn barrel behind the ball, from the launcher's ink pixels: ink within 2.5 ball radii of the line through the
 * ball along the drawn launch direction `unit`, behind the ball, covering most of that stretch, on both sides of the
 * axis (a tube's two rails, or a filled band; a line along one side only is the top of a cliff the ball sits on). An
 * estimate (a hand-drawn cannon has no exact axis). The mouth is the ball's centre, the length runs from the back end
 * of that ink to it, the thickness is twice the 75th percentile of the ink's distance from the axis over the front
 * half of the stretch (the carriage and wheels sit under the back half), between 2 and 4 ball radii. Null when there
 * is no barrel there (a ball with an arrow, a ball on a cliff).
 */
export function barrelOf(pixels: Point[], ball: Point, unit: Point, r: number): BarrelFound | null {
  const reach = 14 * r, band = 2.5 * r;
  const ts: number[] = [], ns: number[] = [];
  for (const p of pixels) {
    const dx = p.x - ball.x, dy = p.y - ball.y;
    const t = dx * unit.x + dy * unit.y;
    const n = -dx * unit.y + dy * unit.x;
    if (t > 0.5 * r || t < -reach || Math.abs(n) > band) continue;
    ts.push(t);
    ns.push(n);
  }
  if (ts.length < 20) return null;
  const back = Math.min(...ts);
  if (back > -2 * r) return null;
  // Most of the stretch from the back end to the ball has ink (not a few scraps of a cliff edge).
  const bins = 12;
  const hit = new Uint8Array(bins);
  for (const t of ts) if (t <= 0) hit[Math.min(bins - 1, Math.floor(((t - back) / -back) * bins))] = 1;
  if (hit.reduce((s, v) => s + v, 0) < 0.6 * bins) return null;
  // Ink on both sides of the axis along most of the stretch (two rails): the edge of a box the ball sits on crosses
  // the axis once at a slant, so each side of it covers only part of the stretch.
  const sides = [new Uint8Array(bins), new Uint8Array(bins)];
  for (let i = 0; i < ns.length; i++) {
    if (ts[i] > 0 || Math.abs(ns[i]) <= 0.3 * r) continue;
    sides[ns[i] > 0 ? 1 : 0][Math.min(bins - 1, Math.floor(((ts[i] - back) / -back) * bins))] = 1;
  }
  if (sides.some((s) => s.reduce((a, v) => a + v, 0) < 0.5 * bins)) return null;
  let front = ns.filter((_, i) => ts[i] > back / 2).map(Math.abs);
  if (front.length < 10) front = ns.map(Math.abs);
  front.sort((a, b) => a - b);
  const thickness = Math.min(4 * r, Math.max(2 * r, 2 * front[Math.floor(front.length * 0.75)]));
  const breech = { x: ball.x + unit.x * back, y: ball.y + unit.y * back };
  const muzzle = { x: ball.x, y: ball.y };
  const length = -back;
  const pivot = { x: breech.x + (muzzle.x - breech.x) * PIVOT_SHARE, y: breech.y + (muzzle.y - breech.y) * PIVOT_SHARE };
  return { pivot, breech, muzzle, length, thickness };
}

// ---- The clean barrel's shape ---------------------------------------------------------------------------

/** A clean barrel: `front` world px from the pivot to the mouth, `back` to the breech, `thickness` across. */
export interface BarrelShape {
  front: number;
  back: number;
  thickness: number;
}

/**
 * The barrel's parts in its own frame (x along the axis from the pivot, mouth at +front, y across): the tube, a
 * slightly wider band at the mouth and the round knob (cascabel) on the breech. Proportions follow the thickness T.
 */
export function barrelProfile(s: BarrelShape) {
  const T = s.thickness;
  const hb = 0.5 * T, hm = 0.42 * T;
  const band = Math.min(0.32 * T, 0.22 * s.front);
  const hband = 0.56 * T;
  return {
    tube: [
      { x: -s.back, y: -hb },
      { x: s.front - band, y: -hm },
      { x: s.front - band, y: hm },
      { x: -s.back, y: hb },
    ],
    band: { x: s.front - band, y: -hband, w: band, h: 2 * hband },
    knob: { x: -s.back - 0.1 * T, r: 0.24 * T },
    /** Corner rounding of the tube and the band. */
    round: 0.2 * T,
    bandRound: 0.12 * T,
  };
}

/** The barrel's outline in world px, turned to `angle` (screen radians) about `pivot`: a closed polygon the morph traces. */
export function barrelOutline(pivot: Point, angle: number, s: BarrelShape): Point[] {
  const p = barrelProfile(s);
  const local: Point[] = [
    p.tube[0],
    p.tube[1],
    { x: p.band.x, y: p.band.y },
    { x: p.band.x + p.band.w, y: p.band.y },
    { x: p.band.x + p.band.w, y: p.band.y + p.band.h },
    { x: p.band.x, y: p.band.y + p.band.h },
    p.tube[2],
    p.tube[3],
  ];
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return local.map((q) => ({ x: pivot.x + q.x * cos - q.y * sin, y: pivot.y + q.x * sin + q.y * cos }));
}
