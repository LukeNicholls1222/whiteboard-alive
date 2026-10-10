// Photo -> ink mask -> contours. Everything here runs on-device with OpenCV.js.
//
// Real phone photos are dirty: desk around the paper, shadows, uneven light, faint pencil, ruled / grid paper,
// broken strokes, names and notes. findInk() cleans them up in this order (all sizes are ratios of the shorter
// image side, so the result does not depend on the photo resolution; constants are below):
//
//   1. Two channels: luma (sees every pen colour) and max(R,G,B) (light coloured printing is almost paper-white).
//   2. Background = morphological close on a 1/4 size copy (removes thin ink, keeps shadows and light falloff).
//      darkness = 1 - pixel / background -> shadows, vignetting and lamp gradients cancel out.
//   3. Paper region: if a coloured desk is visible (warm + saturated background: wood, cork, cardboard), paper =
//      the near-grey background, so a shadow on the sheet stays paper and sunlit wood stays desk. Otherwise Otsu on
//      the background brightness splits bright paper from a darker desk. Largest paper blob -> convex hull ->
//      shrink a little (drops the paper edge). Only trusted when the blob is solid and clearly THE paper thing;
//      otherwise (sun stripes, no desk) the whole photo is used and step 7 removes desk bits.
//   4. Candidate ink = darkness above a weak threshold that follows the paper's own grain, and not "light coloured
//      printing" (much darker in luma than in max(R,G,B)) - unless it is clearly dark in luma (blue / red pen).
//   5. Ruled / grid paper: if several long parallel faint lines exist, erase straight runs as faint as them.
//      Then hysteresis: a blob survives if it has a dark seed, or is a long thin line; specks are dropped.
//   6. Gap joining on the skeleton (spurs pruned): endpoint -> endpoint at a corner or on the same broken line,
//      endpoint -> stroke just ahead. Distances are small so separate objects stay separate. Blobs touching the
//      photo border (desk, paper-edge shadow) are never joined, so the drawing cannot get glued to them.
//   7. Small close, contours, then filters: specks; desk / paper-edge slivers (incl. thin lines that run along
//      the paper / photo border for their whole length); binder holes; long printed lines
//      (margin) that are much fainter in max(R,G,B) than the drawing; handwriting (rows of small letters, or a
//      lone small word near the paper border far from the drawing).
//
// Cost: ~50-90 ms in Node (wasm) at WORK_SIZE; expect ~100-250 ms on a phone.

import type { Contour, Point } from './types';

declare global {
  interface Window {
    cv: any;
    Module: any;
  }
}

/** Longest side of the working image. Keeps OpenCV and the physics fast on phones. */
export const WORK_SIZE = 960;

// ---- Tunables (ratios of the shorter image side unless noted) ----
/** Background estimate is computed on an image this many times smaller. */
const BG_DOWNSCALE = 4;
/** Close kernel for the background estimate. Must be wider than the thickest stroke. */
const BG_KERNEL = 0.06;
/** Paper noise = this percentile of darkness on the paper (well below the share of ink / desk in any photo). */
const NOISE_PERCENTILE = 0.8;
/** Darkness (0..1 relative to local paper) a pixel needs to be candidate ink: noise * WEAK_OVER_NOISE, clamped. */
const WEAK_MIN = 0.08;
const WEAK_MAX = 0.16;
const WEAK_OVER_NOISE = 4;
/** Darkness a blob needs somewhere to count as ink (hysteresis seed): weak * STRONG_OVER_WEAK, clamped. */
const STRONG_MIN = 0.16;
const STRONG_MAX = 0.3;
const STRONG_OVER_WEAK = 1.8;
/** A pixel must keep this share of its luma darkness in max(R,G,B) darkness (drops light coloured printing). */
const COLOR_KEEP = 0.35;
/** ...unless its luma darkness is at least this (pen ink of any colour; light printing never gets this dark). */
const INK_SURE = 0.3;
/** Hysteresis: a blob with no dark seed is still kept if it is a line at least this long... */
const LINE_KEEP = 0.1;
/** ...and thin: pixel count <= length * LINE_THIN (i.e. average stroke width below LINE_THIN px). */
const LINE_THIN = 5;
/** Blobs smaller than this (px², ratio of minSide²) are noise. */
const SPECK_AREA = 0.00003;
/** Paper detection: desk must be at most this bright relative to paper, otherwise the whole photo is "paper". */
const PAPER_CONTRAST = 0.8;
/** Paper detection by colour: background with (R-B) and saturation both above this share of max(R,G,B) is desk. */
const DESK_WARM = 0.3;
/** Paper detection by colour: non-desk background darker than this share of the paper brightness is not paper. */
const PAPER_DARKEST = 0.4;
/** Paper detection: the paper blob must cover at least this fraction of the photo. */
const PAPER_MIN_FRACTION = 0.25;
/** Paper detection: the bright blob must fill this much of its convex hull (a sheet is convex). */
const PAPER_SOLIDITY = 0.85;
/** Paper detection: bright area outside the paper blob may be at most this fraction of the blob. */
const PAPER_BRIGHT_OUTSIDE = 0.3;
/** Shrink the paper hull by this much to drop the paper edge line and its shadow. */
const PAPER_MARGIN = 0.012;
/** Contours mostly on the desk side and closer than this to the paper border are desk / paper-edge leftovers. */
const DESK_EDGE = 0.07;
/** Thin lines lying entirely within this distance of the paper / photo border are the paper edge, not ink. */
const EDGE_LINE = 0.045;
/** Ruled-line removal: a straight run longer than this (ratio of paper width) is a ruled-line candidate. */
const RULE_SPAN = 0.45;
/** Ruled-line removal: bridge dots along a rule up to this many half-size px. */
const RULE_BRIDGE = 7;
/** Ruled-line removal: need at least this many parallel candidates. */
const RULE_MIN_COUNT = 3;
/** Ruled-line removal: straight-run pixels up to this multiple of the rules' mean darkness are erased. */
const RULE_FAINT = 1.6;
/** Gap joining: endpoint -> endpoint at a corner (any angle that is not pointing away). */
const JOIN_ENDPOINTS = 0.022;
/** Gap joining: endpoint -> endpoint when both strokes point at each other (same line, broken). */
const JOIN_COLLINEAR = 0.045;
/** Gap joining: endpoint -> any stroke straight ahead. */
const JOIN_BODY = 0.014;
/** Gap joining: endpoint -> any stroke almost dead ahead (within ~16 degrees), e.g. a string that stops short. */
const JOIN_RAY = 0.04;
/** Gap joining: skeleton side branches (end -> junction) shorter than this are pruned before finding endpoints. */
const PRUNE = 0.012;
/** Final close kernel that heals tiny breaks (ratio, odd, >= 3 px). */
const CLOSE_KERNEL = 0.007;
/** Douglas-Peucker epsilon. */
const DP_EPS = 0.005;
/** A contour is too small if its longest side is below this. */
const MIN_SIDE = 1 / 30;
/** ...or if its area is below this (ratio of minSide²) and it is also shorter than MIN_SIDE_AREA_GATE. */
const MIN_AREA = 1 / 2500;
const MIN_SIDE_AREA_GATE = 1 / 12;
/** Printed line filter: straight thin lines at least this long... */
const PRINTED_LEN = 0.35;
/** ...whose max(R,G,B) darkness is below this share of the darkest contour's are coloured printing. */
const PRINTED_FAINT = 0.45;
/** ...and that reach this close to the paper border at one end. */
const PRINTED_EDGE = 0.1;
/** Handwriting: a letter is at most this tall. */
const LETTER_H = 0.065;
/** Handwriting: a word/line of letters is found when this many small blobs sit in a row. */
const LETTER_ROW_MIN = 3;
/** Handwriting / binder holes: "near the paper border" band. */
const BORDER_BAND = 0.14;
/** Handwriting: a lone word is removed only if it is at least this far from every other contour. */
const WORD_ISOLATION = 0.08;

let cvReady: Promise<any> | null = null;

export function loadOpenCV(): Promise<any> {
  if (cvReady) return cvReady;
  cvReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${import.meta.env.BASE_URL}opencv.js`;
    script.async = true;
    script.onload = () => {
      const cv = window.cv;
      // The Emscripten module is itself a "thenable". Resolving a promise with it makes the promise call .then
      // forever, so strip .then before handing it over.
      const done = (m: any) => {
        if (m && typeof m.then === 'function') delete m.then;
        window.cv = m;
        resolve(m);
      };
      if (cv && cv.Mat) done(cv);
      else if (cv && typeof cv.then === 'function') cv.then(done);
      else if (cv) cv.onRuntimeInitialized = () => done(window.cv);
      else reject(new Error('OpenCV.js の読み込みに失敗しました'));
    };
    script.onerror = () => reject(new Error('OpenCV.js の読み込みに失敗しました'));
    document.head.appendChild(script);
  });
  return cvReady;
}

/** Draw any image source into a canvas scaled to WORK_SIZE. */
export function toWorkingCanvas(src: CanvasImageSource, srcW: number, srcH: number): HTMLCanvasElement {
  const scale = Math.min(1, WORK_SIZE / Math.max(srcW, srcH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);
  canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export interface VisionResult {
  width: number;
  height: number;
  ink: Uint8Array;
  paper: HTMLCanvasElement;
  contours: Contour[];
}

export const PAPER_COLOR = '#fbfaf6';

export function extractContours(cv: any, photo: HTMLCanvasElement): VisionResult {
  const src = cv.imread(photo);
  try {
    const { ink, contours } = findInk(cv, src);
    return { width: photo.width, height: photo.height, ink, paper: makePaper(photo, ink), contours };
  } finally {
    src.delete();
  }
}

const odd = (n: number, min = 3) => Math.max(min, Math.round(n) | 1);

/** Core pipeline on an RGBA Mat. Separate from extractContours so it can be tested without a DOM. */
export function findInk(cv: any, src: any): { ink: Uint8Array; contours: Contour[] } {
  const W = src.cols;
  const H = src.rows;
  const N = W * H;
  const minSide = Math.min(W, H);
  const mats: any[] = [];
  const track = <T>(m: T): T => {
    mats.push(m);
    return m;
  };

  try {
    // 1. Two brightness channels: luma (sees every pen colour) and max(R,G,B) (coloured printing ~ paper-white).
    const rgba = src.data as Uint8Array;
    const gMat = track(new cv.Mat(H, W, cv.CV_8UC1));
    const vMat = track(new cv.Mat(H, W, cv.CV_8UC1));
    const g8 = gMat.data as Uint8Array;
    const v8 = vMat.data as Uint8Array;
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      g8[i] = (r * 77 + g * 150 + b * 29) >> 8;
      v8[i] = r > g ? (r > b ? r : b) : g > b ? g : b;
    }

    // 2. Darkness relative to the local paper brightness (shadows, vignetting and lamp gradients cancel out).
    const G = darkness(cv, track, gMat, minSide);
    const V = darkness(cv, track, vMat, minSide);
    const dark = G.dark;

    // 3. Paper region.
    const paper = findPaper(cv, track, G.bgSmall, backgroundColor(cv, track, src, minSide), W, H);

    // 4. Hysteresis threshold inside the paper. Thresholds follow the paper's own grain / JPEG noise.
    const { weakT, strongT } = thresholds(dark, paper.mask);
    const speck = Math.max(4, SPECK_AREA * minSide * minSide);
    const maskMat = track(new cv.Mat(H, W, cv.CV_8UC1));
    const mask = maskMat.data as Uint8Array;
    // Light coloured printing (blue rules, red margin) is dark in luma but nearly white in max(R,G,B); pen ink of
    // any colour keeps a good share of its darkness in both. Mixing with paper scales both, so the ratio holds.
    const vd = V.dark;
    // Saturated pen (blue / red marker) is also bright in max(R,G,B), but far darker in luma than any light
    // printing, so pixels past INK_SURE are ink whatever their colour.
    const inkSure = Math.round(INK_SURE * 255);
    for (let i = 0; i < N; i++) {
      const d = dark[i];
      mask[i] = d >= weakT && paper.mask[i] && (d >= inkSure || vd[i] >= d * COLOR_KEEP) ? 255 : 0;
    }
    const lineKeep = minSide * LINE_KEEP;
    // 5. Ruled / grid lines (before hysteresis, so faint rules touching the drawing cannot ride along with it).
    removeRuledLines(cv, track, maskMat, dark, paper.width, strongT);
    hysteresis(cv, track, maskMat, dark, strongT, speck, lineKeep);

    // 6. Join broken strokes.
    joinGaps(cv, track, maskMat, minSide);

    // 7. Heal tiny breaks, find contours, filter.
    const ck = odd(minSide * CLOSE_KERNEL);
    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(ck, ck)));
    const closed = track(new cv.Mat());
    cv.morphologyEx(maskMat, closed, cv.MORPH_CLOSE, kernel);

    const contoursVec = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(closed, contoursVec, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);
    const hier = hierarchy.data32S;

    interface Cand {
      idx: number;
      rect: { x: number; y: number; width: number; height: number };
      area: number;
      hasHole: boolean;
    }
    let cands: Cand[] = [];
    const minArea = minSide * minSide * MIN_AREA;
    for (let i = 0; i < contoursVec.size(); i++) {
      if (hier[i * 4 + 3] !== -1) continue;
      const c = contoursVec.get(i);
      const rect = cv.boundingRect(c);
      const area = cv.contourArea(c);
      const long = Math.max(rect.width, rect.height);
      const touchesEdge = rect.x <= 1 || rect.y <= 1 || rect.x + rect.width >= W - 1 || rect.y + rect.height >= H - 1;
      const huge = rect.width > W * 0.9 || rect.height > H * 0.9;
      const tiny = long < minSide * MIN_SIDE || (area < minArea && long < minSide * MIN_SIDE_AREA_GATE);
      // Desk / paper-edge leftovers: hug the photo border and are big, or are a thin sliver along that border.
      const along =
        ((rect.y <= 1 || rect.y + rect.height >= H - 1) && rect.width > rect.height * 4) ||
        ((rect.x <= 1 || rect.x + rect.width >= W - 1) && rect.height > rect.width * 4);
      let edgeJunk = touchesEdge && (huge || long > minSide * 0.5 || along);
      if (!tiny && !edgeJunk) {
        // Desk peeking inside the paper hull (curled / rotated paper): outline mostly on desk, hugging the paper edge.
        const pts = c.data32S as Int32Array;
        let desk = 0, nearEdge = Infinity, farEdge = 0;
        const step = Math.max(2, Math.floor(pts.length / 120) * 2);
        let n = 0;
        for (let k = 0; k < pts.length; k += step) {
          n++;
          if (!paper.bright(pts[k], pts[k + 1])) desk++;
          const de = paper.distToEdge(pts[k], pts[k + 1]);
          nearEdge = Math.min(nearEdge, de);
          farEdge = Math.max(farEdge, de);
        }
        edgeJunk = desk > n * 0.5 && nearEdge < minSide * DESK_EDGE;
        // Paper edge / its shadow / the desk line just beyond it: a thin line whose whole length stays within a
        // narrow band along the paper or photo border. A drawn line never hugs the sheet's edge like that.
        const across = Math.min(rect.width, rect.height);
        if (across <= minSide * 0.04 && long >= across * 4 && farEdge < minSide * EDGE_LINE) edgeJunk = true;
      }
      c.delete();
      if (tiny || edgeJunk) continue;
      cands.push({ idx: i, rect, area, hasHole: hier[i * 4 + 2] !== -1 });
    }

    cands = dropHandwriting(cands, minSide, paper.distToEdge);

    // Per-candidate ink stats. Mean max-channel darkness tells coloured printing apart from the drawing.
    const vdMat = track(new cv.Mat(H, W, cv.CV_8UC1));
    vdMat.data.set(V.dark);
    interface Info { cand: Cand; inkPixels: number; meanV: number; drop: boolean }
    const infos: Info[] = [];
    for (const cand of cands) {
      const c = contoursVec.get(cand.idx);
      const one = new cv.MatVector();
      one.push_back(c);
      const filled = cv.Mat.zeros(H, W, cv.CV_8UC1);
      cv.drawContours(filled, one, 0, new cv.Scalar(255), cv.FILLED);
      const strokeOnly = new cv.Mat();
      cv.bitwise_and(filled, closed, strokeOnly);
      const inkPixels = cv.countNonZero(strokeOnly);
      const meanV = cv.mean(vdMat, strokeOnly)[0];
      [one, filled, strokeOnly, c].forEach((x) => x.delete());

      // Binder holes / dark blobs at the paper border: solid, compact, small, near the edge.
      const { rect, area } = cand;
      const solid = inkPixels > 0.85 * Math.max(1, area);
      const compact = Math.max(rect.width, rect.height) < minSide * 0.07 && rect.width < rect.height * 1.6 && rect.height < rect.width * 1.6;
      const hole = solid && compact && paper.distToEdge(rect.x + rect.width / 2, rect.y + rect.height / 2) < minSide * BORDER_BAND * 0.6;
      infos.push({ cand, inkPixels, meanV, drop: hole });
    }
    // Printed lines (notebook margin, a stray rule): long, straight, axis-aligned, thin, and much fainter in
    // max(R,G,B) than the darkest part of the drawing.
    const refV = Math.max(0, ...infos.filter((f) => !f.drop).map((f) => f.meanV));
    for (const f of infos) {
      const r = f.cand.rect;
      const long = Math.max(r.width, r.height);
      const across = Math.min(r.width, r.height);
      const lineLike = long >= minSide * PRINTED_LEN && across <= minSide * 0.04 && f.inkPixels <= long * LINE_THIN;
      if (!lineLike || f.meanV >= refV * PRINTED_FAINT) continue;
      // Printed lines run off to the paper edge; a drawn line usually stops well inside the sheet.
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const ends = r.width >= r.height ? [[r.x, cy], [r.x + r.width, cy]] : [[cx, r.y], [cx, r.y + r.height]];
      if (Math.min(...ends.map(([x, y]) => paper.distToEdge(x, y))) < minSide * PRINTED_EDGE) f.drop = true;
    }
    if (infos.every((f) => f.drop)) infos.forEach((f) => (f.drop = false)); // never return nothing because of these

    const keepMask = track(cv.Mat.zeros(H, W, cv.CV_8UC1));
    const out: Contour[] = [];
    for (const f of infos) {
      if (f.drop) continue;
      const { cand, inkPixels } = f;
      const { rect, area } = cand;
      const c = contoursVec.get(cand.idx);
      const one = new cv.MatVector();
      one.push_back(c);
      cv.drawContours(keepMask, one, 0, new cv.Scalar(255), cv.FILLED);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, Math.max(2, minSide * DP_EPS), true);
      const hullMat = new cv.Mat();
      cv.convexHull(c, hullMat, false, true);
      const m = cv.moments(c);
      out.push({
        id: out.length,
        points: matToPoints(approx),
        hull: matToPoints(hullMat),
        bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        centroid: m.m00 > 0 ? { x: m.m10 / m.m00, y: m.m01 / m.m00 } : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        area: Math.max(area, inkPixels),
        inkPixels,
        hasHole: cand.hasHole,
      });
      [approx, hullMat, one, c].forEach((x) => x.delete());
    }

    // Ink mask restricted to kept contours.
    const inkMat = track(new cv.Mat());
    cv.bitwise_and(closed, keepMask, inkMat);
    const ink = new Uint8Array(inkMat.data);
    return { ink, contours: out };
  } finally {
    mats.forEach((m) => m.delete());
  }
}

type Track = <T>(m: T) => T;

// ---------------------------------------------------------------------------------------------------------------
// 2. Background / darkness

/** Background = close (max then min) on a 1/BG_DOWNSCALE copy: removes thin ink, keeps shadows and light falloff. */
function darkness(cv: any, track: Track, ch: any, minSide: number): { dark: Uint8Array; bgSmall: any } {
  const W = ch.cols;
  const H = ch.rows;
  const small = track(new cv.Mat());
  cv.resize(ch, small, new cv.Size(Math.max(16, Math.round(W / BG_DOWNSCALE)), Math.max(16, Math.round(H / BG_DOWNSCALE))), 0, 0, cv.INTER_AREA);
  const k = odd((minSide * BG_KERNEL) / BG_DOWNSCALE);
  const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
  const bgSmall = track(new cv.Mat());
  cv.morphologyEx(small, bgSmall, cv.MORPH_CLOSE, kernel);
  const bgMat = track(new cv.Mat());
  cv.resize(bgSmall, bgMat, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  const bg = bgMat.data as Uint8Array;
  const v = ch.data as Uint8Array;
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < dark.length; i++) {
    const b = bg[i] < 8 ? 8 : bg[i];
    const d = 1 - v[i] / b;
    dark[i] = d <= 0 ? 0 : d >= 1 ? 255 : (d * 255) | 0;
  }
  return { dark, bgSmall };
}

/** Weak / strong darkness thresholds from the paper noise (high percentile of darkness on the paper). */
function thresholds(dark: Uint8Array, paperMask: Uint8Array): { weakT: number; strongT: number } {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < dark.length; i += 3) if (paperMask[i]) { hist[dark[i]]++; n++; }
  let acc = 0;
  let noise = 0;
  for (let t = 0; t < 256; t++) {
    acc += hist[t];
    if (acc >= n * NOISE_PERCENTILE) { noise = t; break; }
  }
  const clamp = (x: number, lo: number, hi: number) => Math.round(Math.min(hi * 255, Math.max(lo * 255, x)));
  const weakT = clamp(noise * WEAK_OVER_NOISE, WEAK_MIN, WEAK_MAX);
  const strongT = clamp(weakT * STRONG_OVER_WEAK, STRONG_MIN, STRONG_MAX);
  return { weakT, strongT };
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Paper detection

interface PaperInfo {
  /** 1 = inside paper (full resolution). */
  mask: Uint8Array;
  /** Width of the paper (for ruled-line span checks). */
  width: number;
  /** Distance (px) from a point to the paper border (or photo border when there is no visible desk). */
  distToEdge: (x: number, y: number) => number;
  /** True where the background looks like paper (bright class), false on desk / deep shadow. */
  bright: (x: number, y: number) => boolean;
}

/** Background colour (per-channel close on a 1/BG_DOWNSCALE copy, same size as darkness()'s bgSmall). */
function backgroundColor(cv: any, track: Track, src: any, minSide: number): any {
  const small = track(new cv.Mat());
  cv.resize(src, small, new cv.Size(Math.max(16, Math.round(src.cols / BG_DOWNSCALE)), Math.max(16, Math.round(src.rows / BG_DOWNSCALE))), 0, 0, cv.INTER_AREA);
  const k = odd((minSide * BG_KERNEL) / BG_DOWNSCALE);
  const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
  const bg = track(new cv.Mat());
  cv.morphologyEx(small, bg, cv.MORPH_CLOSE, kernel);
  return bg;
}

/**
 * Desk by colour: wood / cork / cardboard is warm and saturated, while white paper stays near-grey even in a deep
 * shadow. Returns a 0/255 "paper-like" mask (small size), or null when there is no clearly coloured desk.
 */
function paperByColor(bgSmall: any, colorBg: any): Uint8Array | null {
  const n = bgSmall.cols * bgSmall.rows;
  const b = bgSmall.data as Uint8Array;
  const c = colorBg.data as Uint8Array;
  const desk = new Uint8Array(n);
  let nDesk = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = c[p], g = c[p + 1], bl = c[p + 2];
    const mx = r > g ? (r > bl ? r : bl) : g > bl ? g : bl;
    const mn = r < g ? (r < bl ? r : bl) : g < bl ? g : bl;
    if (mx > 0 && (r - bl) >= mx * DESK_WARM && (mx - mn) >= mx * DESK_WARM) { desk[i] = 1; nDesk++; }
  }
  if (nDesk < n * 0.03 || nDesk > n * 0.7) return null;
  // Paper reference brightness: 90th percentile of the non-desk background. Very dark non-desk areas (black
  // objects, deep corners) are not paper either.
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) if (!desk[i]) hist[b[i]]++;
  let acc = 0, ref = 255;
  for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= (n - nDesk) * 0.1) { ref = t; break; } }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = !desk[i] && b[i] >= ref * PAPER_DARKEST ? 255 : 0;
  return out;
}

function findPaper(cv: any, track: Track, bgSmall: any, colorBg: any, W: number, H: number): PaperInfo {
  const sw = bgSmall.cols;
  const sh = bgSmall.rows;
  const sx = W / sw;
  const sy = H / sh;
  const whole: PaperInfo = {
    mask: new Uint8Array(W * H).fill(1),
    width: W,
    distToEdge: (x, y) => Math.min(x, y, W - x, H - y),
    bright: () => true,
  };

  const bin = track(new cv.Mat(sh, sw, cv.CV_8UC1));
  const byColor = paperByColor(bgSmall, colorBg);
  if (byColor) {
    // A coloured desk is visible: colour separates it from the paper even where a shadow falls on the sheet
    // (brightness alone calls shadowed paper "desk" and sunlit wood "paper").
    bin.data.set(byColor);
    const ok = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, ok); // detach objects touching the sheet by a thin bridge
  } else {
    const t = cv.threshold(bgSmall, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    // Is the dark class really a desk, or just a shadowed part of the paper?
    const b = bgSmall.data as Uint8Array;
    const bm0 = bin.data as Uint8Array;
    let hi = 0, nHi = 0, lo = 0, nLo = 0;
    for (let i = 0; i < b.length; i++) {
      if (bm0[i]) { hi += b[i]; nHi++; } else { lo += b[i]; nLo++; }
    }
    if (!nHi || !nLo || t <= 0) return whole;
    hi /= nHi;
    lo /= nLo;
    if (lo > PAPER_CONTRAST * hi || nLo < b.length * 0.03) return whole;
  }
  const bm = bin.data as Uint8Array;
  const brightSmall = new Uint8Array(bm);
  const bright = (x: number, y: number) =>
    brightSmall[Math.min(sh - 1, Math.max(0, Math.floor(y / sy))) * sw + Math.min(sw - 1, Math.max(0, Math.floor(x / sx)))] > 0;
  // From here on, when the paper outline is not trusted we still know which side is darker (desk / deep shadow).
  const wholeB: PaperInfo = { ...whole, bright };

  // Largest bright blob -> convex hull.
  const cs = track(new cv.MatVector());
  const hh = track(new cv.Mat());
  cv.findContours(bin, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  let best = -1;
  let bestArea = 0;
  for (let i = 0; i < cs.size(); i++) {
    const c = cs.get(i);
    const a = cv.contourArea(c);
    if (a > bestArea) { bestArea = a; best = i; }
    c.delete();
  }
  if (best < 0 || bestArea < sw * sh * PAPER_MIN_FRACTION) return wholeB;

  const c = cs.get(best);
  const hullMat = new cv.Mat();
  cv.convexHull(c, hullMat, false, true);
  c.delete();
  // Trust the hull only if it is mostly bright. Strong sun stripes split the paper into lit bands; then the
  // largest band's hull is not the paper, and we fall back to the whole photo (contour filters handle the desk).
  const hullArea = cv.contourArea(hullMat);
  // Also, the paper must be THE bright thing: lots of bright area outside the hull means the split was lighting.
  let nBright = 0;
  for (let i = 0; i < bm.length; i++) if (bm[i]) nBright++;
  if (bestArea < hullArea * PAPER_SOLIDITY || nBright - bestArea > bestArea * PAPER_BRIGHT_OUTSIDE) {
    hullMat.delete();
    return wholeB;
  }
  const hs = hullMat.data32S as Int32Array;
  const poly: Point[] = [];
  for (let i = 0; i < hs.length; i += 2) poly.push({ x: hs[i] * sx, y: hs[i + 1] * sy });
  hullMat.delete();

  // Rasterise the hull at full resolution, then shrink by the margin.
  const minSide = Math.min(W, H);
  const pm = track(cv.Mat.zeros(H, W, cv.CV_8UC1));
  const flat: number[] = [];
  poly.forEach((p) => flat.push(Math.round(p.x), Math.round(p.y)));
  const ptsMat = track(cv.matFromArray(poly.length, 1, cv.CV_32SC2, flat));
  const pv = track(new cv.MatVector());
  pv.push_back(ptsMat);
  cv.drawContours(pm, pv, 0, new cv.Scalar(255), cv.FILLED);
  const mk = odd(minSide * PAPER_MARGIN * 2);
  const ek = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(mk, mk)));
  cv.erode(pm, pm, ek);
  const mask = new Uint8Array(pm.data);

  let minX = Infinity, maxX = -Infinity;
  poly.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); });

  const distToEdge = (x: number, y: number) => {
    // Distance to the hull polygon (inside points only matter).
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const q = poly[(i + 1) % poly.length];
      d = Math.min(d, segDist(x, y, a.x, a.y, q.x, q.y));
    }
    return Math.min(d, x, y, W - x, H - y);
  };
  return { mask, width: Math.max(1, maxX - minX), distToEdge, bright };
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Hysteresis

function hysteresis(cv: any, track: Track, maskMat: any, dark: Uint8Array, strongT: number, speck: number, lineKeep: number) {
  const labels = track(new cv.Mat());
  const stats = track(new cv.Mat());
  const cents = track(new cv.Mat());
  const n = cv.connectedComponentsWithStats(maskMat, labels, stats, cents, 8, cv.CV_32S);
  const lab = labels.data32S as Int32Array;
  const st = stats.data32S as Int32Array;
  const keep = new Uint8Array(n);
  for (let i = 0; i < lab.length; i++) if (lab[i] && dark[i] >= strongT) keep[lab[i]] = 1;
  for (let l = 1; l < n; l++) {
    const long = Math.max(st[l * 5 + 2], st[l * 5 + 3]);
    // A faint but long, thin stroke is a real line even without a dark seed (noise never forms long thin chains).
    if (long >= lineKeep && st[l * 5 + 4] <= long * LINE_THIN) keep[l] = 1;
    if (st[l * 5 + 4] < speck) keep[l] = 0;
  }
  const mask = maskMat.data as Uint8Array;
  for (let i = 0; i < lab.length; i++) mask[i] = keep[lab[i]] ? 255 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Ruled / grid line removal

/**
 * Find families of long straight near-horizontal / near-vertical lines (ruled or grid paper). If there are at least
 * RULE_MIN_COUNT of them, erase every straight run in that direction whose pixels are about as faint as those
 * lines. Darker strokes (the drawing) survive even where they run along or cross a rule.
 */
function removeRuledLines(cv: any, track: Track, maskMat: any, dark: Uint8Array, paperWidth: number, maxFaint: number): boolean {
  const W = maskMat.cols;
  const H = maskMat.rows;
  // Half size: cheaper, and slightly tilted / curved 1 px lines are easier to catch.
  const hw = Math.round(W / 2);
  const hh = Math.round(H / 2);
  const half = track(new cv.Mat());
  cv.resize(maskMat, half, new cv.Size(hw, hh), 0, 0, cv.INTER_AREA);
  cv.threshold(half, half, 40, 255, cv.THRESH_BINARY);
  const seg = Math.max(8, Math.round(Math.min(hw, hh) * 0.04));
  const found = track(cv.Mat.zeros(hh, hw, cv.CV_8UC1));
  let ruleSum = 0;
  let ruleCnt = 0;
  for (const horizontal of [true, false]) {
    // Bridge dotted faint rules along the line and thicken across it (a few degrees of tilt still leaves a
    // continuous run), then keep only straight runs.
    const thick = track(new cv.Mat());
    const tk = track(cv.getStructuringElement(cv.MORPH_RECT, horizontal ? new cv.Size(RULE_BRIDGE, 3) : new cv.Size(3, RULE_BRIDGE)));
    cv.dilate(half, thick, tk);
    const lk = track(cv.getStructuringElement(cv.MORPH_RECT, horizontal ? new cv.Size(seg, 1) : new cv.Size(1, seg)));
    const lines = track(new cv.Mat());
    cv.morphologyEx(thick, lines, cv.MORPH_OPEN, lk);

    const labels = track(new cv.Mat());
    const stats = track(new cv.Mat());
    const cents = track(new cv.Mat());
    const n = cv.connectedComponentsWithStats(lines, labels, stats, cents, 8, cv.CV_32S);
    const st = stats.data32S as Int32Array;
    const spanMin = (paperWidth / 2) * RULE_SPAN;
    const isLong = new Uint8Array(n);
    let count = 0;
    for (let l = 1; l < n; l++) {
      const span = horizontal ? st[l * 5 + 2] : st[l * 5 + 3];
      const across = horizontal ? st[l * 5 + 3] : st[l * 5 + 2];
      if (span >= spanMin && across < span * 0.12) { isLong[l] = 1; count++; }
    }
    if (count < RULE_MIN_COUNT) continue;
    const lab = labels.data32S as Int32Array;
    const hm = half.data as Uint8Array;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        const i = y * hw + x;
        if (hm[i] && isLong[lab[i]]) { ruleSum += dark[Math.min(H - 1, y * 2) * W + Math.min(W - 1, x * 2)]; ruleCnt++; }
      }
    }
    cv.bitwise_or(found, lines, found);
  }
  if (!ruleCnt) return false;
  const faintT = Math.min(maxFaint, (ruleSum / ruleCnt) * RULE_FAINT);
  const full = track(new cv.Mat());
  cv.resize(found, full, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST);
  const gk = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  cv.dilate(full, full, gk);
  const m = maskMat.data as Uint8Array;
  const f = full.data as Uint8Array;
  for (let i = 0; i < m.length; i++) if (f[i] && m[i] && dark[i] < faintT) m[i] = 0;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// 6. Gap joining

function joinGaps(cv: any, track: Track, maskMat: any, minSide: number) {
  const W = maskMat.cols;
  const H = maskMat.rows;
  const m = maskMat.data as Uint8Array;
  const skel = thin(m, W, H);

  const labels = track(new cv.Mat());
  const nLab = cv.connectedComponents(maskMat, labels, 8, cv.CV_32S);
  const lab = labels.data32S as Int32Array;
  // Blobs touching the photo border are desk / paper-edge shadow (the drawing sits inside the sheet). Never join
  // into or out of them, or a stroke ending near the paper edge gets glued to the desk and is thrown away with it.
  const border = new Uint8Array(nLab);
  for (let x = 0; x < W; x++) { border[lab[x]] = 1; border[lab[(H - 1) * W + x]] = 1; }
  for (let y = 0; y < H; y++) { border[lab[y * W]] = 1; border[lab[y * W + W - 1]] = 1; }
  border[0] = 0;

  // Stroke width ~ ink / skeleton length.
  let inkN = 0, skN = 0;
  for (let i = 0; i < m.length; i++) { if (m[i]) inkN++; if (skel[i]) skN++; }
  const strokeW = Math.max(2, Math.min(6, Math.round(inkN / Math.max(1, skN))));

  // Prune short side branches (pen jitter, leftovers of erased rules) so endpoints and their directions come
  // from the real stroke. Free stroke ends and short fragments are untouched.
  const prune = Math.max(3, Math.round(minSide * PRUNE));
  pruneSkeleton(skel, W, H, prune);

  // Endpoints with their outward direction (walk back along the skeleton).
  const WALK = Math.max(6, Math.round(minSide * 0.012));
  interface End { x: number; y: number; dx: number; dy: number; label: number }
  const ends: End[] = [];
  const nb = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!skel[i] || border[lab[i]] || crossings(skel, i, W) !== 1) continue;
      // Walk back along the stroke.
      let cur = i, steps = 0;
      const seen = new Set<number>([i]);
      while (steps < WALK) {
        let next = -1;
        for (const o of nb) {
          const j = cur + o;
          if (skel[j] && !seen.has(j)) { next = j; break; }
        }
        if (next < 0) break;
        seen.add(next);
        cur = next;
        steps++;
      }
      if (steps < 3) continue; // spur / dot
      const bx = cur % W, by = (cur / W) | 0;
      const len = Math.hypot(x - bx, y - by) || 1;
      ends.push({ x, y, dx: (x - bx) / len, dy: (y - by) / len, label: lab[i] });
    }
  }
  if (!ends.length) return;

  const rE = minSide * JOIN_ENDPOINTS;
  const rC = minSide * JOIN_COLLINEAR;
  const rB = minSide * JOIN_BODY;
  const rR = minSide * JOIN_RAY;
  const links: [number, number, number, number][] = [];
  const used = new Uint8Array(ends.length);

  for (let a = 0; a < ends.length; a++) {
    if (used[a]) continue;
    const e = ends[a];
    let best = Infinity;
    let tx = 0, ty = 0, partner = -1;

    // Endpoint -> endpoint.
    for (let b = 0; b < ends.length; b++) {
      if (b === a || used[b]) continue;
      const f = ends[b];
      const vx = f.x - e.x, vy = f.y - e.y;
      const d = Math.hypot(vx, vy);
      if (d > rC || d < 1) continue;
      const ca = (vx * e.dx + vy * e.dy) / d;
      const cb = (-vx * f.dx - vy * f.dy) / d;
      let ok = false;
      if (ca > 0.85 && cb > 0.85) ok = true; // broken straight line
      else if (d <= rE && ca > -0.2 && cb > -0.2) ok = f.label !== e.label || (ca > 0.5 && cb > 0.5); // corner / closing a loop
      if (ok && d < best) { best = d; tx = f.x; ty = f.y; partner = b; }
    }

    // Endpoint -> another stroke ahead: close within a wide cone, or a bit further almost dead ahead.
    const r = Math.ceil(Math.max(rB, rR));
    for (let oy = -r; oy <= r; oy++) {
      const y = e.y + oy;
      if (y < 0 || y >= H) continue;
      for (let ox = -r; ox <= r; ox++) {
        const x = e.x + ox;
        if (x < 0 || x >= W) continue;
        const j = y * W + x;
        if (!m[j] || lab[j] === e.label || border[lab[j]]) continue;
        const d = Math.hypot(ox, oy);
        if (d >= best || d > r) continue;
        const cos = (ox * e.dx + oy * e.dy) / d;
        if (!((d <= rB && cos >= 0.77) || (d <= rR && cos >= 0.96))) continue;
        best = d; tx = x; ty = y; partner = -1;
      }
    }

    if (best === Infinity) continue;
    used[a] = 1;
    if (partner >= 0) used[partner] = 1;
    links.push([e.x, e.y, tx, ty]);
  }

  for (const [x1, y1, x2, y2] of links) {
    cv.line(maskMat, new cv.Point(x1, y1), new cv.Point(x2, y2), new cv.Scalar(255), strokeW, cv.LINE_8);
  }
}

/** Number of 0->1 transitions around pixel i (1 = stroke end, 2 = inside a stroke, >= 3 = junction). */
function crossings(s: Uint8Array, i: number, W: number): number {
  const r = [s[i - W], s[i - W + 1], s[i + 1], s[i + W + 1], s[i + W], s[i + W - 1], s[i - 1], s[i - W - 1]];
  let c = 0;
  for (let k = 0; k < 8; k++) if (!r[k] && r[(k + 1) & 7]) c++;
  return c;
}

/** Remove side branches: an end whose path reaches a junction within `n` px is a spur and is erased. */
function pruneSkeleton(s: Uint8Array, W: number, H: number, n: number) {
  const nb = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
  const ends: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (s[i] && crossings(s, i, W) === 1) ends.push(i);
    }
  }
  for (const e of ends) {
    const path = [e];
    const seen = new Set<number>(path);
    let cur = e;
    let junction = false;
    while (path.length <= n) {
      let next = -1;
      for (const o of nb) {
        const j = cur + o;
        if (s[j] && !seen.has(j)) { next = j; break; }
      }
      if (next < 0) break;
      if (crossings(s, next, W) >= 3) { junction = true; break; }
      seen.add(next);
      path.push(next);
      cur = next;
    }
    if (junction) for (const i of path) s[i] = 0;
  }
}

/** Zhang-Suen thinning on a 0/255 mask. Returns a 0/1 skeleton. Only visits ink pixels. */
function thin(mask: Uint8Array, W: number, H: number): Uint8Array {
  const s = new Uint8Array(W * H);
  let pts: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (mask[i]) { s[i] = 1; pts.push(i); }
    }
  }
  const del: number[] = [];
  for (let iter = 0; iter < 40; iter++) {
    let changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (const i of pts) {
        if (!s[i]) continue;
        const p2 = s[i - W], p3 = s[i - W + 1], p4 = s[i + 1], p5 = s[i + W + 1];
        const p6 = s[i + W], p7 = s[i + W - 1], p8 = s[i - 1], p9 = s[i - W - 1];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const A = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) +
          (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (A !== 1) continue;
        if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        del.push(i);
      }
      if (del.length) changed = true;
      for (const i of del) s[i] = 0;
    }
    if (!changed) break;
    pts = pts.filter((i) => s[i]);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// 7. Handwriting filter

interface RectLike { x: number; y: number; width: number; height: number }

function dropHandwriting<T extends { rect: RectLike; hasHole: boolean }>(
  cands: T[],
  minSide: number,
  distToEdge: (x: number, y: number) => number,
): T[] {
  const letterH = minSide * LETTER_H;
  const small = (c: T) => c.rect.height <= letterH && c.rect.width <= letterH * 2.2;
  const drop = new Set<T>();

  // (a) Rows of small blobs: words and notes. Group by horizontal neighbours with similar height and baseline.
  const smalls = cands.filter(small);
  const seen = new Set<T>();
  for (const s of smalls) {
    if (seen.has(s)) continue;
    const group: T[] = [s];
    seen.add(s);
    for (let k = 0; k < group.length; k++) {
      const g = group[k];
      for (const o of smalls) {
        if (seen.has(o)) continue;
        const gap = Math.max(o.rect.x - (g.rect.x + g.rect.width), g.rect.x - (o.rect.x + o.rect.width));
        const cyG = g.rect.y + g.rect.height / 2;
        const cyO = o.rect.y + o.rect.height / 2;
        const hMax = Math.max(g.rect.height, o.rect.height);
        if (gap < hMax * 1.2 && Math.abs(cyG - cyO) < hMax * 0.6) {
          group.push(o);
          seen.add(o);
        }
      }
    }
    if (group.length >= LETTER_ROW_MIN) group.forEach((g) => drop.add(g));
  }

  // (b) A lone small word (cursive) near the paper border, far from the drawing.
  const rest = cands.filter((c) => !drop.has(c));
  for (const c of rest) {
    const r = c.rect;
    const wordLike = r.height <= letterH * 1.2 && r.width >= r.height * 1.5 && r.width <= minSide * 0.25;
    if (!wordLike) continue;
    if (distToEdge(r.x + r.width / 2, r.y + r.height / 2) > minSide * BORDER_BAND) continue;
    let near = Infinity;
    for (const o of rest) {
      if (o === c) continue;
      near = Math.min(near, rectGap(r, o.rect));
    }
    if (near > minSide * WORD_ISOLATION) drop.add(c);
  }

  // Never remove everything: if all that is left is "handwriting", keep it (something must move).
  if (drop.size === cands.length) return cands;
  return cands.filter((c) => !drop.has(c));
}

function rectGap(a: RectLike, b: RectLike): number {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

function matToPoints(mat: any): Point[] {
  const d = mat.data32S;
  const pts: Point[] = [];
  for (let i = 0; i < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] });
  return pts;
}

/** Ink keeps its original colour (darkened a bit); everything else becomes flat paper. Removes shadows. */
function makePaper(photo: HTMLCanvasElement, ink: Uint8Array): HTMLCanvasElement {
  const W = photo.width;
  const H = photo.height;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(photo, 0, 0);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < ink.length; i++) {
    const p = i * 4;
    if (ink[i]) {
      d[p] = d[p] * 0.6;
      d[p + 1] = d[p + 1] * 0.6;
      d[p + 2] = d[p + 2] * 0.6;
    } else {
      d[p] = 251;
      d[p + 1] = 250;
      d[p + 2] = 246;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Canvas with contour outlines and id labels, sent to the AI so it can map ids to shapes. */
export function annotate(paper: HTMLCanvasElement, contours: Contour[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = paper.width;
  canvas.height = paper.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(paper, 0, 0);
  ctx.lineWidth = 2;
  ctx.font = 'bold 22px sans-serif';
  for (const c of contours) {
    const hue = (c.id * 67) % 360;
    ctx.strokeStyle = `hsl(${hue} 80% 45%)`;
    ctx.fillStyle = `hsl(${hue} 80% 40%)`;
    ctx.strokeRect(c.bbox.x - 3, c.bbox.y - 3, c.bbox.w + 6, c.bbox.h + 6);
    ctx.fillText(`#${c.id}`, c.bbox.x, Math.max(20, c.bbox.y - 6));
  }
  return canvas;
}
