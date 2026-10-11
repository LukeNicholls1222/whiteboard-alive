// Spring + mass: the drawn zigzag runs between a fixed end and the drawn block.
// The block oscillates along the spring's axis (vertical hanging spring, or horizontal spring on a floor);
// the zigzag cut-out stretches and squashes between its two ends. The motion is integrated exactly along that
// axis (spring-motion.ts), so the energy graph's Total stays flat and the period is 2π√(m/k); the Matter
// constraint is kept only as the spring's two ends for the drawing (stiffness 0: it pulls on nothing).

import Matter from 'matter-js';
import type { BBox, CleanPart, Contour, Point, SceneBuilder, Sprite, Untidy, ViewRect } from '../types';
import { bodyOutline, supportAcross } from '../clean';
import { drawnSupport, fmt, rayExit, snapDir, TIDY, tidyLog, untidyMatters, untidyMove, untidySegment } from './tidy';
import { contourMask, cutSprite, eraseFromPaper, maskBounds, roleOf } from './common';
import { axisOf, centroidOf, count, looksLikeSpring, outlineZig, planSpring, spans, splitMerged, type SpringPlan } from './spring-plan';
import { MAX_VIEW_ASPECT, MIN_VIEW_ASPECT, STEP_ACCEL, STEP_MS } from '../sim';
import { noteFor, scaleFor } from '../units';
import { springPxPerMeter } from '../defaults';
import { LMAX_FRACTION } from '../vectors';
import { SpringOscillator, springSetup, springView } from './spring-motion';

/** Oscillation amplitude as a fraction of the drawn spring length (clamped below). */
const KICK_FRACTION = 0.25;
const KICK_MIN_PX = 12;
const KICK_MAX_PX = 80;

/** ?debug: one "[spring] ..." line with why the fixed end, axis and block were chosen. */
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

/** One plan per photo (~0.1 s): rebuilds after a slider or a typed number reuse it. */
const PLANS = new WeakMap<Uint8Array, SpringPlan>();
/** The largest view shown for a photo: a rebuild (Mass / Spring pill, typed number) never shows less of the world. */
const VIEWS = new WeakMap<Uint8Array, ViewRect>();

const FIXED_ROLES = new Set(['pivot', 'ground', 'incline', 'wheel', 'cannon']);
const MASS_ROLES = new Set(['mass', 'bob', 'projectile']);

function bboxGap(a: BBox, b: BBox) {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

const holds = (c: Contour, p: Point) => p.x >= c.bbox.x && p.x <= c.bbox.x + c.bbox.w && p.y >= c.bbox.y && p.y <= c.bbox.y + c.bbox.h;
const boxCentre = (b: BBox): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * Without AI roles: the stroke group holding the block the plan found (the tightest one around it). Without one: the
 * biggest, squarest closed shape, but never a zigzag (its outline runs 1.8 times round its hull or more): a coil or a
 * dense zigzag fills a big area and once won over a small box.
 */
function guessMass(pool: Contour[], plan: SpringPlan, notes: string[]): Contour | undefined {
  if (plan.mass) {
    const at = boxCentre(plan.mass.box);
    const around = pool.filter((c) => holds(c, at)).sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];
    if (around) return around;
  }
  const score = (c: Contour) => {
    const sq = Math.min(c.bbox.w, c.bbox.h) / Math.max(1, c.bbox.w, c.bbox.h);
    const zig = outlineZig(c.points, c.hull);
    return c.area * sq * (c.hasHole ? 1.5 : 1) * (zig >= 1.8 && pool.length > 1 ? 0.02 : 1);
  };
  for (const c of pool) {
    const zig = outlineZig(c.points, c.hull);
    if (zig >= 1.8 && pool.length > 1) notes.push(`zigzag blob #${c.id} zig=${zig.toFixed(1)}`);
  }
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

/** Without AI roles: whatever touches (or nearly touches) the weight is the spring. */
function guessSpring(pool: Contour[], mass: Contour[]): Contour[] {
  if (!pool.length || !mass.length) return [];
  const mb = mass[0].bbox;
  const reach = 0.5 * Math.max(mb.w, mb.h) + 20;
  // A long thin line running past the block on both sides is a floor or ceiling, not the spring.
  const isLine = (c: Contour) =>
    (c.bbox.h < 0.3 * c.bbox.w && c.bbox.x < mb.x - 10 && c.bbox.x + c.bbox.w > mb.x + mb.w + 10) ||
    (c.bbox.w < 0.3 * c.bbox.h && c.bbox.y < mb.y - 10 && c.bbox.y + c.bbox.h > mb.y + mb.h + 10);
  const near = pool.filter((c) => !isLine(c) && mass.some((m) => bboxGap(c.bbox, m.bbox) < reach));
  if (near.length) return near;
  return [[...pool].sort((a, b) => b.inkPixels - a.inkPixels)[0]];
}

/**
 * Remove the fixed end (ceiling / wall) from a spring mask. Walks from the block end towards the far end and
 * cuts where ink first spreads well outside the spring's own band (the stroke suddenly gets wider).
 * Everything from there on stays in the background. `us` is ordered block end first.
 */
function cutFixedEnd(mask: Uint8Array, W: number, sp: ReturnType<typeof spans>, us: number[], vertical: boolean): number[] {
  if (us.length < 6) return us;
  // The spring's own band across the axis, measured on the block-side 60% (away from any ceiling).
  const near = us.slice(0, Math.max(3, Math.floor(us.length * 0.6)));
  const los = near.map((u) => sp.lo[u]).sort((a, b) => a - b);
  const his = near.map((u) => sp.hi[u]).sort((a, b) => a - b);
  const vlo = los[Math.floor(los.length * 0.05)];
  const vhi = his[Math.min(his.length - 1, Math.floor(his.length * 0.95))];
  const margin = 0.3 * (vhi - vlo) + 6;
  let cut = -1;
  for (let k = Math.floor(us.length * 0.4); k < us.length; k++) {
    const u = us[k];
    if (sp.lo[u] < vlo - margin || sp.hi[u] > vhi + margin) {
      cut = k;
      break;
    }
  }
  if (cut < 0) return us;
  for (let j = cut; j < us.length; j++) {
    const u = us[j];
    for (let v = sp.lo[u]; v <= sp.hi[u]; v++) mask[vertical ? u * W + v : v * W + u] = 0;
  }
  return us.slice(0, cut);
}

/** Cut wide end rows/columns off a block mask (a floor or wall drawn in the same stroke). Returns true if anything was cut. */
function trimFlanges(mask: Uint8Array, W: number, H: number): boolean {
  let cut = false;
  for (const vertical of [true, false]) {
    const sp = spans(mask, W, H, vertical);
    const us: number[] = [];
    for (let u = 0; u < sp.n; u++) if (sp.width(u) > 0) us.push(u);
    if (us.length < 5) continue;
    const median = us.map((u) => sp.width(u)).sort((a, b) => a - b)[us.length >> 1];
    const wide = (u: number) => sp.width(u) > 1.6 * median + 4;
    const drop: number[] = [];
    for (let k = 0; k < us.length * 0.4 && wide(us[k]); k++) drop.push(us[k]);
    for (let k = us.length - 1; k > us.length * 0.6 && wide(us[k]); k--) drop.push(us[k]);
    for (const u of drop) for (let v = sp.lo[u]; v <= sp.hi[u]; v++) mask[vertical ? u * W + v : v * W + u] = 0;
    if (drop.length) cut = true;
  }
  return cut;
}

export const buildSpring: SceneBuilder = (input) => {
  const { width: W, height: H, contours } = input;
  if (!contours.length) throw new Error('spring: no contours');
  const role = (c: Contour) => roleOf(input, c.id);
  // Fixed end, axis and block from the ink first (spring-plan.ts): a big zigzag or coil is never taken for the block.
  const plan = PLANS.get(input.ink) ?? planSpring(input.ink, W, H);
  PLANS.set(input.ink, plan);
  const massNotes: string[] = [];

  const fixed = contours.filter((c) => {
    const r = role(c);
    return !!r && (FIXED_ROLES.has(r.role) || (r.static && r.role !== 'spring' && !MASS_ROLES.has(r.role)));
  });
  const free = contours.filter((c) => !fixed.includes(c));
  const pool = free.length ? free : contours;

  let massC = pool.filter((c) => MASS_ROLES.has(role(c)?.role ?? ''));
  if (!massC.length) massC = [guessMass(pool, plan, massNotes)!];
  else if (plan.fixed && plan.mass?.kind === 'closed') {
    // The AI's block holds no closed box, but another stroke group holds the closed box at the spring's far end
    // (the AI took the zigzag for the block): that box is the block.
    const at = boxCentre(plan.mass.box);
    const box = pool.filter((c) => holds(c, at)).sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];
    if (box && !massC.some((c) => holds(c, at))) {
      massNotes.push(`AI block #${massC.map((c) => c.id).join(',')} holds no box → #${box.id}`);
      massC = [box];
    }
  }
  const rest = pool.filter((c) => !massC.includes(c));
  let springC = rest.filter((c) => role(c)?.role === 'spring');
  // Without an AI spring: ceiling, spring and block are often one stroke. If the block contour splits into
  // block + something spring-like on one side, that is the spring; stray marks elsewhere stay in the background.
  let premerged: { mass: Uint8Array; spring: Uint8Array } | null = null;
  if (!springC.length) {
    const split = splitMerged(W, H, contourMask(input, massC), plan);
    if (split && looksLikeSpring(W, H, split, plan)) premerged = split;
    else springC = guessSpring(rest, massC);
  }

  // Ink of everything else (ceiling, floor, wall) stays put, even where it touches the block or spring.
  const others = contours.filter((c) => !massC.includes(c) && !springC.includes(c));
  const otherMask = others.length ? contourMask(input, others, 1) : null;
  const notOther = (m: Uint8Array) => {
    if (otherMask) for (let i = 0; i < m.length; i++) if (otherMask[i]) m[i] = 0;
    return m;
  };

  let massMask = notOther(contourMask(input, massC));
  // useRect: the block's outline isn't a single clean contour, so its body is the box around its mask.
  let useRect = false;
  let springMask: Uint8Array | null = null;
  if (premerged) {
    massMask = notOther(premerged.mass);
    springMask = notOther(premerged.spring);
    useRect = true;
  } else if (springC.length) {
    springMask = notOther(contourMask(input, springC));
    for (let i = 0; i < springMask.length; i++) if (massMask[i]) springMask[i] = 0;
    if (count(springMask) < 40) springMask = null;
  }
  if (!springMask) {
    const split = splitMerged(W, H, massMask, plan);
    if (split) {
      massMask = split.mass;
      springMask = split.spring;
      useRect = true;
    }
  }
  if (trimFlanges(massMask, W, H)) useRect = true;

  const mb = maskBounds(massMask, W, H) ?? massC[0].bbox;
  const cm = centroidOf(massMask, W) ?? massC[0].centroid;

  // Spring ends: anchor (fixed, away from the block) and attach (on the block side).
  let anchor: Point;
  let attach: Point;
  let vertical = true;
  let haveSpringSprite = false;
  const cs = springMask ? centroidOf(springMask, W) : null;
  if (springMask && cs) {
    vertical = axisOf(plan, cm, cs);
    const massPlus = (vertical ? cm.y - cs.y : cm.x - cs.x) > 0;
    // Stray block pixels past the block's near edge (e.g. a corner left over by a split) belong to the block,
    // otherwise the spring's moving end lands on the far corner of the block.
    const near = vertical ? (massPlus ? mb.y : mb.y + mb.h - 1) : massPlus ? mb.x : mb.x + mb.w - 1;
    for (let i = 0; i < springMask.length; i++) {
      if (!springMask[i]) continue;
      const u = vertical ? (i / W) | 0 : i % W;
      if (massPlus ? u >= near : u <= near) {
        springMask[i] = 0;
        massMask[i] = 1;
      }
    }
    const sp = spans(springMask, W, H, vertical);
    const us: number[] = [];
    for (let u = 0; u < sp.n; u++) if (sp.width(u) > 0) us.push(u);
    if (massPlus) us.reverse(); // us[0] = block end, us[last] = far (fixed) end
    // A ceiling / wall drawn joined to the spring stays in the background: cut where the stroke suddenly widens.
    const kept = cutFixedEnd(springMask, W, sp, us, vertical).reverse(); // kept[0] = fixed end
    const at = (u: number): Point => {
      const v = (sp.lo[u] + sp.hi[u]) / 2;
      return vertical ? { x: v, y: u } : { x: u, y: v };
    };
    if (kept.length) {
      anchor = at(kept[0]);
      attach = at(kept[kept.length - 1]);
      haveSpringSprite = Math.hypot(attach.x - anchor.x, attach.y - anchor.y) >= 8;
    } else anchor = attach = { x: cm.x, y: mb.y };
  } else {
    anchor = { x: cm.x, y: mb.y };
    attach = anchor;
  }
  if (!haveSpringSprite) {
    // No usable spring found: hang the block from an invisible spring above it so it still bounces.
    attach = { x: cm.x, y: mb.y };
    anchor = { x: cm.x, y: mb.y - Math.max(60, mb.h * 1.5) };
    vertical = true;
  }

  // Block body: the drawn outline's convex hull when we have it, else the block's bounding box.
  // onStep puts the block exactly where the spring motion says every step; there is nothing for it to collide with.
  const bodyOpts = { friction: 0, frictionStatic: 0, frictionAir: 0, restitution: 0, collisionFilter: { group: -1, category: 0, mask: 0 } };
  let body: Matter.Body | undefined;
  if (!useRect && massC.length === 1 && massC[0].hull.length >= 3) {
    const c = massC[0];
    body = Matter.Bodies.fromVertices(c.centroid.x, c.centroid.y, [c.hull], bodyOpts);
    if (body) {
      const hb = body.bounds;
      Matter.Body.translate(body, { x: c.bbox.x - hb.min.x, y: c.bbox.y - hb.min.y });
    }
  }
  if (!body) body = Matter.Bodies.rectangle(mb.x + mb.w / 2, mb.y + mb.h / 2, Math.max(8, mb.w), Math.max(8, mb.h), bodyOpts);
  Matter.Body.setInertia(body, Infinity); // slides along the spring, never tumbles

  // Tidy-up (tidy.ts): a spring drawn within 15° of vertical / horizontal is straightened and meets the middle of the
  // block's face towards it. A hanging spring keeps its top on the ceiling and the block moves under it; a spring
  // lying on a floor keeps the block on the floor and its end slides along the wall to the block's middle. The
  // physics below (motion axis, rest position) is built from the tidied ends, so the block oscillates straight
  // along the tidied spring. Steeper springs stay as drawn.
  const tidyNotes: string[] = [];
  const drawnAnchor = { ...anchor }, drawnAttach = { ...attach }, drawnCentre = { ...body.position };
  let straight = false;
  if (haveSpringSprite) {
    const axisName = vertical ? 'vertical' : 'horizontal';
    const snap = snapDir({ x: attach.x - anchor.x, y: attach.y - anchor.y }, vertical ? 'v' : 'h');
    tidyNotes.push(`spring ${fmt(snap.off)} off ${axisName}${snap.snapped ? ` → ${axisName}` : TIDY ? ' (kept: slanted on purpose)' : ''}`);
    if (snap.snapped) {
      straight = true;
      const u = snap.dir; // from the fixed end towards the block
      const back = { x: -u.x, y: -u.y };
      // How far the drawn spring missed the middle of the block's face (across the spring).
      const face0 = rayExit(bodyOutline(body), body.position, back);
      const miss = vertical ? drawnAttach.x - face0.x : drawnAttach.y - face0.y;
      if (vertical) Matter.Body.translate(body, { x: anchor.x - body.position.x, y: 0 });
      else anchor = { x: anchor.x, y: body.position.y };
      attach = rayExit(bodyOutline(body), body.position, back);
      tidyNotes.push(`attach offset ${Math.abs(miss).toFixed(1)}px → centre (${vertical ? 'block' : 'wall end'} moved ${Math.abs(miss).toFixed(1)}px)`);
    }
  }

  const L0 = Math.hypot(attach.x - anchor.x, attach.y - anchor.y);
  const dir = { x: (attach.x - anchor.x) / L0, y: (attach.y - anchor.y) / L0 };

  // k and m are independent (spring-motion.ts): an entered k (else the tuned default) and an entered mass (else 1 kg).
  // The screen period is the physical 2π√(m/k) played at this drawing's slow-motion factor.
  const kgNote = noteFor(input.analysis, 'mass', ['block', 'bob', 'ball'])?.value;
  const kNote = noteFor(input.analysis, 'spring_constant')?.value;
  // The drawn spring length is its size on paper (for a hanging spring that is the stretched, at-rest length).
  const measures = haveSpringSprite ? { spring: L0 } : {};
  // Without an entered length a hanging (or standing) spring is drawn long enough for its stretch m·g/k (defaults.ts);
  // a spring lying on a floor keeps the paper's scale.
  const defaultPpm = springPxPerMeter(L0, vertical);
  const springScale = scaleFor(input, measures, 1, defaultPpm);
  const setup = springSetup(kNote, kgNote, springScale, vertical ? L0 / springScale.pxPerMeter : undefined);
  const OMEGA2 = setup.omega2;
  const omega = Math.sqrt(OMEGA2);

  // The block moves along the rail the spring hangs or lies on: straight down/up for a hanging spring, sideways for
  // one on a floor (a spring drawn slanted pulls the block along that rail, as before). The drawing is the rest
  // position under normal gravity (a hanging spring doesn't just sag).
  const axis = vertical ? { x: 0, y: dir.y < 0 ? -1 : 1 } : { x: dir.x < 0 ? -1 : 1, y: 0 };
  // Only for how far the kick may go (the spring's own rest length, never below 0.3 of what was drawn).
  const restLength = Math.max(0.3 * L0, L0 - (STEP_ACCEL * dir.y) / OMEGA2);
  // The spring's two ends for the drawing (zigzag, stretched cut-out, labels). Stiffness 0: Matter applies nothing.
  const spring = Matter.Constraint.create({
    pointA: { ...anchor },
    bodyB: body,
    pointB: { x: attach.x - body.position.x, y: attach.y - body.position.y },
    length: L0,
    damping: 0,
  });
  spring.stiffness = 0; // after create(): create() takes 0 for "unset" and would make it rigid

  // Never start still: kick it along the spring.
  const amp = Math.min(0.6 * restLength, Math.max(KICK_MIN_PX, Math.min(KICK_MAX_PX, KICK_FRACTION * L0)));
  const motion = new SpringOscillator(OMEGA2, STEP_ACCEL * axis.y, amp * omega);
  const home = { ...body.position };
  const place = () => {
    Matter.Body.setPosition(body!, { x: home.x + axis.x * motion.u, y: home.y + axis.y * motion.u });
    Matter.Body.setVelocity(body!, { x: axis.x * motion.v, y: axis.y * motion.v });
  };
  place();
  const bb = body.bounds;
  // The picture shows the whole swing (spring-motion.ts springView): both turning points and the longest velocity
  // arrow, from the middle of the swing and its amplitude, never from where the block is now. Those only change when
  // gravity does (slider, voice, Moon), so the view holds still between changes, and it only ever grows for a photo.
  const swingBox = { x: bb.min.x, y: bb.min.y, w: bb.max.x - bb.min.x, h: bb.max.y - bb.min.y };
  const limits = { arrowFraction: LMAX_FRACTION, minAspect: MIN_VIEW_ASPECT, maxAspect: MAX_VIEW_ASPECT };
  let shown = VIEWS.get(input.ink) ?? null;
  let seen = { eq: NaN, amp: NaN };
  const view = (): ViewRect | null => {
    const eq = motion.eq, a = motion.amplitude();
    if (Math.abs(eq - seen.eq) < 0.01 && Math.abs(a - seen.amp) < 0.01) return shown;
    seen = { eq, amp: a };
    const need = springView({ photoW: W, photoH: H, block: swingBox, axis, eq, amp: a }, limits, shown);
    const inside = (o: ViewRect, n: ViewRect) => n.x >= o.x - 0.5 && n.y >= o.y - 0.5 && n.x + n.w <= o.x + o.w + 0.5 && n.y + n.h <= o.y + o.h + 0.5;
    if (need && !(shown && inside(shown, need))) {
      shown = need;
      VIEWS.set(input.ink, need);
    }
    return shown;
  };
  view();
  // Every step:the exact motion under the engine's gravity right now (slider, voice, Moon mode), then the block there.
  const onStep = (engine: Matter.Engine) => {
    const g = engine.gravity;
    motion.step((g.x * axis.x + g.y * axis.y) * g.scale * STEP_MS * STEP_MS);
    place();
  };

  const sprites: Sprite[] = [];
  const masks: Uint8Array[] = [massMask];
  if (springMask && haveSpringSprite) {
    masks.push(springMask);
    sprites.push({ ...cutSprite(input, springMask), follow: { kind: 'stretch', anchor: { ...anchor }, constraint: spring, origin: { ...attach } } });
  }
  sprites.push({ ...cutSprite(input, massMask), follow: { kind: 'body', body, origin: { ...body.position }, originAngle: body.angle } });

  const block = body;

  // Clean figure: a hatched wall / ceiling across the spring's fixed end, an even zigzag from there to the block's
  // attachment point (it stretches and squashes with the motion), the block as its physics outline. A spring lying on
  // a floor also gets the floor line under the block.
  const across = vertical ? bb.max.x - bb.min.x : bb.max.y - bb.min.y;
  const zigWidth = Math.min(60, Math.max(16, 0.45 * across));
  const coils = Math.min(12, Math.max(5, Math.round(L0 / (0.45 * zigWidth))));
  const clean: CleanPart[] = [];
  if (!vertical) {
    const floorY = bb.max.y;
    const x0 = Math.min(anchor.x, bb.min.x) - 4, x1 = Math.max(anchor.x, bb.max.x) + 2 * amp + 20;
    clean.push({ kind: 'ground', y: floorY, x0: dir.x > 0 ? x0 : Math.min(anchor.x, bb.min.x) - 2 * amp - 20, x1: dir.x > 0 ? x1 : Math.max(anchor.x, bb.max.x) + 4 });
  }
  // The fixed end's support: across the (tidied) spring. A ceiling / wall drawn more than 15° off level / plumb stays
  // at its drawn angle; within 15° it is level / plumb (it already is, across a straightened spring).
  const half = Math.max(30, 0.8 * across);
  const support = supportAcross(anchor, dir, half);
  const drawnDir = { x: (drawnAttach.x - drawnAnchor.x) / (Math.hypot(drawnAttach.x - drawnAnchor.x, drawnAttach.y - drawnAnchor.y) || 1), y: (drawnAttach.y - drawnAnchor.y) / (Math.hypot(drawnAttach.x - drawnAnchor.x, drawnAttach.y - drawnAnchor.y) || 1) };
  // The support as drawn: the measured ink line at the fixed end, else across the drawn spring.
  let drawnSupportDeg = (Math.atan2(drawnDir.y, drawnDir.x) * 180) / Math.PI + 90;
  if (haveSpringSprite) {
    const keep = (i: number) => !massMask[i] && !(springMask && springMask[i]);
    const fixedEnd = drawnSupport(input.ink, W, H, drawnAnchor, vertical ? 'h' : 'v', half, Math.max(8, 0.3 * zigWidth), keep);
    if (fixedEnd) {
      drawnSupportDeg = fixedEnd.drawn;
      const name = vertical ? 'ceiling' : 'wall';
      const axisDeg = vertical ? 0 : 90;
      if (straight && fixedEnd.used !== axisDeg) {
        // Slanted on purpose: keep the drawn angle, still through the spring's end.
        const r = (fixedEnd.used * Math.PI) / 180, v = { x: Math.cos(r), y: Math.sin(r) };
        const n = { x: -v.y, y: v.x };
        const side = n.x * dir.x + n.y * dir.y > 0 ? { x: -n.x, y: -n.y } : n;
        Object.assign(support, { from: { x: anchor.x - v.x * half, y: anchor.y - v.y * half }, to: { x: anchor.x + v.x * half, y: anchor.y + v.y * half }, side });
        tidyNotes.push(`${name} ${fmt(fixedEnd.drawn)} (kept: slanted on purpose)`);
      } else tidyNotes.push(`${name} ${fmt(fixedEnd.drawn)} → ${fmt(straight ? axisDeg : (Math.atan2(dir.y, dir.x) * 180) / Math.PI + 90)}`);
    }
  }
  const springPart: CleanPart = { kind: 'spring', from: () => anchor, to: () => Matter.Constraint.pointBWorld(spring), coils, width: zigWidth };
  const blockPart: CleanPart = { kind: 'body', body: block, tone: 'mass' };
  if (TIDY && haveSpringSprite) {
    // Where each part was drawn, for the morph to snap it from.
    const sf = support.kind === 'support' ? support : null;
    if (sf) {
      const t = { x: sf.to.x - sf.from.x, y: sf.to.y - sf.from.y };
      const r = (drawnSupportDeg * Math.PI) / 180;
      let v = { x: Math.cos(r), y: Math.sin(r) };
      if (v.x * t.x + v.y * t.y < 0) v = { x: -v.x, y: -v.y };
      const u: Untidy = untidySegment(sf.from, sf.to, { x: drawnAnchor.x - v.x * half, y: drawnAnchor.y - v.y * half }, { x: drawnAnchor.x + v.x * half, y: drawnAnchor.y + v.y * half });
      if (untidyMatters(u, half)) support.untidy = u;
    }
    const us = untidySegment(anchor, attach, drawnAnchor, drawnAttach);
    if (untidyMatters(us, L0)) springPart.untidy = us;
    const ub = untidyMove(drawnCentre, body.position);
    if (untidyMatters(ub, 1)) blockPart.untidy = ub;
  }
  if (DEBUG) {
    const from = massC.some((c) => MASS_ROLES.has(role(c)?.role ?? '')) && !massNotes.length ? 'AI role' : 'drawing';
    console.log(
      `[spring] ${plan.why}${massNotes.length ? `; ${massNotes.join(', ')}` : ''} → built: ${haveSpringSprite ? (vertical ? 'vertical' : 'horizontal') : 'invisible vertical'} spring, block (${from}) ${Math.round(mb.w)}×${Math.round(mb.h)} at (${Math.round(mb.x)},${Math.round(mb.y)}), fixed end (${Math.round(drawnAnchor.x)},${Math.round(drawnAnchor.y)})`,
    );
  }
  tidyLog('Spring', tidyNotes);
  clean.push(support, springPart, blockPart);

  return {
    bodies: [body],
    constraints: [spring],
    sprites,
    clean,
    background: eraseFromPaper(input, masks),
    label: 'Spring and mass',
    onStep,
    view,
    measures,
    defaultPxPerMeter: defaultPpm,
    parts: {
      spring: {
        at: () => {
          const end = Matter.Constraint.pointBWorld(spring);
          return { x: (anchor.x + end.x) / 2, y: (anchor.y + end.y) / 2 };
        },
      },
      block: {
        at: () => block.position,
        clear: Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) / 2,
        body: block,
        kg: setup.kg,
        kgFrom: kgNote ? 'input' : 'assumed',
      },
    },
    physics: {
      springK: { from: setup.kFrom, note: kNote, value: setup.k, omega2: OMEGA2, stretch: () => motion.stretch() },
    },
    // Fastest through the middle of the swing: amplitude × ω (it never loses energy).
    speedHint: amp * omega,
  };
};
