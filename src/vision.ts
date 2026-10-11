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
//      the background brightness splits bright paper from a darker desk - unless the split boundary is soft (a
//      shadow across the sheet, not a desk edge), then the whole photo is paper. Desk strips too narrow for the
//      background close are peeled in from the photo border by colour. Largest paper blob -> convex hull ->
//      shrink a little (drops the paper edge). Only trusted when the blob is solid and clearly THE paper thing;
//      otherwise (sun stripes, no desk) the whole photo is used and step 7 removes desk bits.
//   4. Candidate ink = darkness above a weak threshold that follows the paper's own grain, and not "light coloured
//      printing" (much darker in luma than in max(R,G,B)) - unless it is clearly dark in luma (blue / red pen).
//      Black ink mode (default; the demo uses black markers): ink must also darken R, G and B about equally, each
//      relative to that channel's own local background ("neutral" = least / most darkened channel; black marker
//      ~0.97, pencil ~0.9, blue / red pen ~0.2-0.6, coffee stains / fold shadows / paper-edge lines / wood
//      ~0.65-0.87). Pixels below BLACK_PIXEL are dropped after rule removal (pens, coloured rules, wood grain);
//      in step 7 whole contours whose dark core is less neutral than BLACK_CONTOUR (lowered for a pencil drawing,
//      see BLACK_BELOW_MAIN) are dropped (stains, fold shadows, paper-edge lines, desk). If there is little clearly
//      black ink, more clearly coloured pen than black, or black mode keeps (next to) nothing, the photo is redone
//      in "any dark ink" mode (the old behaviour, so blue / red pen drawings still work). ?ink=any forces the old
//      mode, ?ink=black disables the fallback (testing). ?debug logs the decision as "[vision] ink mode: ...".
//   5. Ruled / grid paper: if many long parallel rule-faint lines exist, erase straight runs as faint as them, and
//      each rule along its fitted line across the whole sheet (broken stretches, ends at the margin).
//      Then hysteresis: a blob survives if it has a dark seed, or is a long thin line; specks are dropped.
//   6. Gap joining on the skeleton (spurs pruned): endpoint -> endpoint at a corner or on the same broken line,
//      endpoint -> stroke just ahead. Distances are small so separate objects stay separate. Blobs touching the
//      photo border (desk, paper-edge shadow) are never joined, so the drawing cannot get glued to them.
//   7. Small close, contours, then filters: specks; desk / paper-edge slivers - big things touching the photo border,
//      unless they are a drawing cut off by the frame on one side (see cutByFrame) - (incl. thin lines that run along
//      the paper / photo border for their whole length, and small bits pressed into a band along the photo border);
//      binder holes; long printed lines
//      (margin) that are much fainter in max(R,G,B) than the drawing; handwriting (rows of small letters, or a
//      lone small word near the paper border far from the drawing); shadows (a contour whose surroundings are about as
//      dark as its own ink and clearly darker than the paper: the corner or edge of a phone / hand shadow, not a line,
//      which has paper on both sides).
//   8. Faint retry: if all that is kept is (next to) no ink - light pencil can be only ~6 % darker than the paper,
//      below the normal 8 % candidate threshold - steps 2-7 are redone with lower thresholds against a narrower
//      background (STAGES), and the result with the most ink is used. ?debug logs each stage.
//
// Cost: ~50-90 ms in Node (wasm) at WORK_SIZE (black ink mode adds ~4 ms; its fallback redoes steps 4-7 only for
// coloured drawings that pass the first check); expect ~100-250 ms on a phone.

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
/** Black ink mode: a candidate pixel's least / most darkened channel ratio must be at least this (0..1). */
const BLACK_PIXEL = 0.75;
/**
 * Black ink mode: a contour's dark core (channel darkness summed, then least / most) must reach this ratio (black
 * marker ~0.97; stains, fold shadows, paper-edge lines, desk 0.78-0.87)...
 */
const BLACK_CONTOUR = 0.88;
/** ...or, if the main contour is less neutral (pencil on tinted paper ~0.9), that contour's ratio minus this... */
const BLACK_BELOW_MAIN = 0.06;
/** ...but never less than this. */
const BLACK_CONTOUR_MIN = 0.82;
/** Black ink mode: use it only if clearly black ink (and later, the ink of the black contours kept) covers at least
 * this share of the paper... */
const BLACK_MIN_SHARE = 0.002;
/** ...and clearly coloured dark ink (ratio below this) is not more than the black ink (a blue / red pen drawing). */
const COLOURED = 0.5;
/** Black ink mode is abandoned after the fact if clearly coloured strokes exceed this share of the black ink kept. */
const COLOURED_OVER_BLACK = 0.5;
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
/** Paper detection: a bright / dark boundary softer than this (see boundarySharpness) is a shadow, not the desk. */
const SHADOW_SOFT = 0.5;
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
/** Ruled-line removal: need at least this many parallel rule-faint candidates. */
const RULE_MIN_COUNT = 5;
/** Ruled-line removal: pixels on a rule up to this multiple of the rules' 90th-percentile darkness are erased... */
const RULE_FAINT = 1.2;
/** ...but never pixels darker than this (0..1): pen ink crossing a rule survives. */
const RULE_CAP = 0.45;
/** Ruled-line removal: a long run whose median darkness is above this multiple of the typical rule's is drawn. */
const RULE_DRAWN = 1.6;
/** Ruled-line removal: thickness (half-size px) of a rule's straight extension across the sheet. */
const RULE_EXTEND = 5;
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
/** ...that may lean by up to this much (box width per unit length, ~6 degrees)... */
const PRINTED_TILT = 0.1;
/** ...and that reach this close to the paper border at one end. */
const PRINTED_EDGE = 0.1;
/** Handwriting: a letter is at most this tall. */
const LETTER_H = 0.065;
/** Handwriting: a word/line of letters is found when this many small blobs sit in a row. */
const LETTER_ROW_MIN = 3;
/** Handwriting / binder holes: "near the paper border" band. */
const BORDER_BAND = 0.14;
/** Desk / paper-corner leftovers: a contour this close to a photo border and within BORDER_BAND of it is dropped. */
const BORDER_TOUCH = 0.025;
/** Handwriting: a lone word is removed only if it is at least this far from every other contour. */
const WORD_ISOLATION = 0.08;
/** Faint retry: background close kernel (narrower: follows a shadow's corners closely, still wider than a pencil line). */
const FAINT_BG_KERNEL = 0.035;
/** Faint retry runs when the kept contours hold less ink than this share of the photo (none, or a speck or two). */
const FEW_INK = 0.0015;
/** Shadow test: ring of this width (ratio) just outside a contour's ink... */
const SHADOW_RING_W = 0.006;
/** ...a contour whose ring is this dark (share of ring pixels about as dark as the ink next to them) is the corner or
 * edge of a big dark area (a phone / hand shadow, an object), not a line: a drawn line has paper on both sides. */
const SHADOW_RING = 0.3;
/** ...counting only ring pixels at least this much darker than the paper (0..1): a shadow, not paper grain. */
const SHADOW_DEPTH = 0.08;

/**
 * One detection pass. The first one is the normal pipeline; if it keeps (next to) no ink - faint pencil on bright
 * paper, which can be only ~6 % darker than the paper - the photo is redone with any dark ink and lower thresholds,
 * on a darkness taken against a narrower background (a wide shadow cancels out better).
 * weak / strong: [times the paper noise, min, max] (0..1 darkness).
 */
interface Stage {
  name: string;
  bgKernel: number;
  weak: readonly [number, number, number];
  strong: readonly [number, number, number];
}
const STAGES: Stage[] = [
  { name: 'normal', bgKernel: BG_KERNEL, weak: [WEAK_OVER_NOISE, WEAK_MIN, WEAK_MAX], strong: [STRONG_OVER_WEAK, STRONG_MIN, STRONG_MAX] },
  { name: 'faint', bgKernel: FAINT_BG_KERNEL, weak: [3, 0.04, 0.08], strong: [1.6, 0.07, 0.14] },
  { name: 'fainter', bgKernel: FAINT_BG_KERNEL, weak: [2.5, 0.025, 0.05], strong: [1.5, 0.04, 0.08] },
];

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

/** auto = black ink only, falling back to any dark ink; black = black only (no fallback); any = the old behaviour. */
export type InkMode = 'auto' | 'black' | 'any';

function urlParams(): URLSearchParams | null {
  return typeof location === 'undefined' ? null : new URLSearchParams(location.search);
}

function inkModeFromUrl(): InkMode {
  const v = urlParams()?.get('ink');
  return v === 'any' || v === 'black' ? v : 'auto';
}

type InkResult = { ink: Uint8Array; contours: Contour[]; inkMode: 'black' | 'any' };

/**
 * Core pipeline on an RGBA Mat. Separate from extractContours so it can be tested without a DOM.
 * Normal pass first; if it keeps (next to) no ink, faint retries with lower thresholds (see STAGES). The result with
 * the most ink wins. ?ink=black (testing) never retries.
 */
export function findInk(cv: any, src: any, mode: InkMode = inkModeFromUrl()): InkResult {
  const inkOf = (r: InkResult) => r.contours.reduce((s, c) => s + c.inkPixels, 0);
  const few = src.cols * src.rows * FEW_INK;
  let best = findInkAt(cv, src, mode, STAGES[0]);
  debugLog(`stage ${STAGES[0].name}: ${best.contours.length} contours, ${inkOf(best)} ink px${inkOf(best) < few ? ` (under ${Math.round(few)}: retry fainter)` : ''}`);
  if (mode === 'black') return best;
  for (let s = 1; s < STAGES.length && inkOf(best) < few; s++) {
    const r = findInkAt(cv, src, mode, STAGES[s]);
    debugLog(`stage ${STAGES[s].name}: ${r.contours.length} contours, ${inkOf(r)} ink px${inkOf(r) > inkOf(best) ? ' -> used' : ''}`);
    if (inkOf(r) > inkOf(best)) best = r;
  }
  if (!best.contours.length) debugLog('no lines at any stage: the safety net drops the most line-like marks (or the middle)');
  return best;
}

function findInkAt(cv: any, src: any, mode: InkMode, stage: Stage): InkResult {
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
    // (A faint retry measures darkness against a narrower background; the paper is always found on the normal one.)
    const G0 = darkness(cv, track, gMat, minSide);
    const G = stage.bgKernel === BG_KERNEL ? G0 : darkness(cv, track, gMat, minSide, stage.bgKernel);
    const V = darkness(cv, track, vMat, minSide, stage.bgKernel);
    const dark = G.dark;

    // 3. Paper region.
    const colorBg = backgroundColor(cv, track, src, minSide);
    const paper = findPaper(cv, track, G0.bgSmall, colorBg, W, H);

    // 4. Hysteresis threshold inside the paper. Thresholds follow the paper's own grain / JPEG noise.
    const { weakT, strongT } = thresholds(dark, paper.mask, stage);
    const speck = Math.max(4, SPECK_AREA * minSide * minSide);
    // Light coloured printing (blue rules, red margin) is dark in luma but nearly white in max(R,G,B); pen ink of
    // any colour keeps a good share of its darkness in both. Mixing with paper scales both, so the ratio holds.
    const vd = V.dark;
    // Saturated pen (blue / red marker) is also bright in max(R,G,B), but far darker in luma than any light
    // printing, so pixels past INK_SURE are ink whatever their colour.
    const inkSure = Math.round(INK_SURE * 255);

    const anyMask = track(new cv.Mat(H, W, cv.CV_8UC1));
    const am = anyMask.data as Uint8Array;
    for (let i = 0; i < N; i++) {
      const d = dark[i];
      am[i] = d >= weakT && paper.mask[i] && (d >= inkSure || vd[i] >= d * COLOR_KEEP) ? 255 : 0;
    }
    // 5. Ruled / grid lines (before hysteresis, so faint rules touching the drawing cannot ride along with it).
    // Found on all candidate ink even in black mode: coloured rules then still form a family, and the faint stubs
    // where a rule meets a black stroke are erased with them.
    removeRuledLines(cv, track, anyMask, dark, paper.width);

    // How evenly each candidate pixel darkens R, G and B (255 = grey / black ink, low = coloured).
    const { neutral, chan } = neutrality(rgba, colorBg.bg, am, W, H);
    const blackPix = Math.round(BLACK_PIXEL * 255);
    const blackSure = Math.round(BLACK_CONTOUR * 255);
    const colouredT = Math.round(COLOURED * 255);

    let useBlack = mode !== 'any';
    let paperN = 0, colouredAll = 0;
    if (mode === 'auto') {
      // Enough clearly black ink, and not a drawing in coloured pen (with maybe a few black bits)? Counted on the
      // candidate ink after rule removal, so blue rules do not count as coloured pen.
      let black = 0, coloured = 0;
      for (let i = 0; i < N; i++) {
        if (!paper.mask[i]) continue;
        paperN++;
        const d = dark[i];
        if (!am[i]) continue;
        if (neutral[i] < colouredT) colouredAll++;
        if (d < strongT) continue;
        if (neutral[i] >= blackSure) black++;
        else if (d >= inkSure && neutral[i] < colouredT) coloured++;
      }
      useBlack = black >= paperN * BLACK_MIN_SHARE && coloured <= black;
      debugLog(`black ink ${black} px (${((black / Math.max(1, paperN)) * 100).toFixed(2)}% of paper), coloured ${coloured} px`);
    }

    let result = useBlack ? pass(true, mode === 'auto') : null;
    if (result && mode === 'auto') {
      // A faint coloured pen drawing (thin blue ballpoint) is too light to trip the check above, and black mode
      // then keeps only grey leftovers (paper edges, desk). If clearly coloured stroke-like ink outweighs what black
      // mode kept, the drawing is coloured: redo it with any dark ink.
      const kept = result.contours.reduce((s, c) => s + c.inkPixels, 0);
      // (Stroke-sized pieces are a subset of all clearly coloured candidate pixels: skip the labelling when even all
      // of them could not tip the balance.)
      const coloured =
        colouredAll > kept * COLOURED_OVER_BLACK ? colouredStrokes(cv, track, anyMask, neutral, colouredT, minSide * LINE_KEEP) : 0;
      debugLog(`black contours ${kept} px (${((kept / Math.max(1, paperN)) * 100).toFixed(2)}% of paper), coloured strokes ${coloured} px`);
      // Also give up if black mode kept next to nothing (a faint coloured drawing whose pixels are too washed out to
      // count as clearly coloured; the grey leftovers are then all black mode found).
      if (coloured > kept * COLOURED_OVER_BLACK || kept < paperN * BLACK_MIN_SHARE) result = null;
    }
    if (mode === 'auto') debugLog(`ink mode: ${result ? 'black' : 'fallback: any dark ink'}`);
    else debugLog(`ink mode: ${mode}${stage === STAGES[0] ? ' (forced by ?ink=)' : ` (${stage.name} retry)`}`);
    if (!result) result = pass(false, false)!;
    return result;

    /**
     * Steps 4-7 for one ink mode. black: only near-neutral ink. strict: return null instead of falling back to
     * non-black contours when nothing black survives (the caller then redoes the photo in "any dark ink" mode).
     */
    function pass(black: boolean, strict: boolean): { ink: Uint8Array; contours: Contour[]; inkMode: 'black' | 'any' } | null {
      const maskMat = track(anyMask.clone());
      if (black) {
        const mask = maskMat.data as Uint8Array;
        for (let i = 0; i < N; i++) if (mask[i] && neutral[i] < blackPix) mask[i] = 0;
      }
      hysteresis(cv, track, maskMat, dark, strongT, speck, minSide * LINE_KEEP);
      // Black mode: real ink pixels (before gap joining / closing add pixels that say nothing about the ink colour),
      // and their dark core (past strongT; the faint rim is noisier). Used to judge each contour's colour in step 7.
      let rawInk: any = null, coreMat: any = null;
      if (black) {
        rawInk = track(maskMat.clone());
        coreMat = track(maskMat.clone());
        const core = coreMat.data as Uint8Array;
        for (let i = 0; i < N; i++) if (core[i] && dark[i] < strongT) core[i] = 0;
      }

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
      const atBorder: Cand[] = [];
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
        // ...unless it is a drawing cut off by the photo frame (a wheel or a ramp corner past the edge): it meets the
        // frame along only a short stretch of its outline, touches one photo side, and reaches well into the photo. Desk objects (a laptop, a tumbler, the desk strip) lie along the frame.
        if (edgeJunk && !huge && !along && cutByFrame(c.data32S as Int32Array, rect, W, H, minSide, cv.arcLength(c, true))) {
          debugLog(`contour [${rect.x},${rect.y} ${rect.width}x${rect.height}] touches the photo edge but runs into the photo -> kept`);
          edgeJunk = false;
        }
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
        if (edgeJunk && long > minSide * 0.1)
          debugLog(`contour [${rect.x},${rect.y} ${rect.width}x${rect.height}] desk / paper edge${touchesEdge ? ' (touches the photo edge)' : ''} -> dropped`);
        if (tiny || edgeJunk) continue;
        const cand = { idx: i, rect, area, hasHole: hier[i * 4 + 2] !== -1 };
        // Desk / paper-corner leftovers: something pressed against a photo border and lying wholly in a narrow band
        // along it (the drawing sits inside the sheet, away from the photo border).
        const touch = minSide * BORDER_TOUCH;
        const band = minSide * BORDER_BAND;
        const squeezed =
          (rect.x <= touch && rect.x + rect.width <= band) ||
          (rect.y <= touch && rect.y + rect.height <= band) ||
          (W - rect.x - rect.width <= touch && W - rect.x <= band) ||
          (H - rect.y - rect.height <= touch && H - rect.y <= band);
        (squeezed ? atBorder : cands).push(cand);
      }
      if (!cands.length) cands = atBorder; // never return nothing because of this filter
      if (strict && !cands.length) return null;

      cands = dropHandwriting(cands, minSide, paper.distToEdge);

      // Per-candidate ink stats. Mean max-channel darkness tells coloured printing apart from the drawing.
      const vdMat = track(new cv.Mat(H, W, cv.CV_8UC1));
      vdMat.data.set(V.dark);
      // Shadow test (see SHADOW_RING): the darkest ink luma within the ring width of each pixel.
      const ringR = Math.max(2, Math.round(minSide * SHADOW_RING_W));
      const ringKernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2 * ringR + 1, 2 * ringR + 1)));
      const inkMinMat = track(new cv.Mat(H, W, cv.CV_8UC1));
      {
        const im = inkMinMat.data as Uint8Array, cl = closed.data as Uint8Array;
        for (let i = 0; i < N; i++) im[i] = cl[i] ? g8[i] : 255;
        cv.erode(inkMinMat, inkMinMat, ringKernel);
      }
      // A ring pixel only counts if it is also clearly darker than the paper as a whole (paper = 90th percentile luma
      // on the sheet): the grain around a faint pencil rim is not a shadow.
      let paperL = 255;
      {
        const hist = new Uint32Array(256);
        let n = 0;
        for (let i = 0; i < N; i += 3) if (paper.mask[i]) { hist[g8[i]]++; n++; }
        for (let t = 255, acc = 0; t >= 0; t--) if ((acc += hist[t]) >= n * 0.1) { paperL = t; break; }
      }
      const shadowL = paperL * (1 - SHADOW_DEPTH);
      /** Share of the ring just outside this contour's ink that is about as dark as the ink next to it. */
      const shadowShare = (strokeOnly: any, r: Cand['rect']): number => {
        const x0 = Math.max(0, r.x - ringR - 1), y0 = Math.max(0, r.y - ringR - 1);
        const x1 = Math.min(W, r.x + r.width + ringR + 1), y1 = Math.min(H, r.y + r.height + ringR + 1);
        const rect = new cv.Rect(x0, y0, x1 - x0, y1 - y0);
        const sub = strokeOnly.roi(rect);
        const dil = new cv.Mat();
        cv.dilate(sub, dil, ringKernel);
        const dd = dil.data as Uint8Array, cl = closed.data as Uint8Array, im = inkMinMat.data as Uint8Array, bg = G.bg;
        const rw = x1 - x0;
        let ring = 0, darkRing = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = y * W + x;
            if (!dd[(y - y0) * rw + (x - x0)] || cl[i]) continue;
            ring++;
            const ink = im[i];
            if (g8[i] <= shadowL && g8[i] <= ink + Math.max(3, 0.5 * (bg[i] - ink))) darkRing++;
          }
        }
        sub.delete();
        dil.delete();
        return ring ? darkRing / ring : 0;
      };
      interface Info { cand: Cand; inkPixels: number; meanV: number; drop: boolean; blackness: number; weight: number; shadow: number }
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
        const shadow = shadowShare(strokeOnly, cand.rect);
        let blackness = 1, weight = 0;
        if (black) {
          // Black mode: least / most darkened channel, summed over the contour's dark core (or all its real ink if the
          // core is tiny). Pixels added by gap joining / closing are not ink and say nothing about its colour.
          const so = strokeOnly.data as Uint8Array, core = coreMat.data as Uint8Array, raw = rawInk.data as Uint8Array;
          const r = cand.rect;
          let nCore = 0;
          const cs = [0, 0, 0], rs = [0, 0, 0];
          for (let y = r.y; y < r.y + r.height; y++) {
            for (let i = y * W + r.x, end = i + r.width; i < end; i++) {
              if (!so[i] || !raw[i]) continue;
              weight++;
              const p = i * 3;
              rs[0] += chan[p]; rs[1] += chan[p + 1]; rs[2] += chan[p + 2];
              if (core[i]) { nCore++; cs[0] += chan[p]; cs[1] += chan[p + 1]; cs[2] += chan[p + 2]; }
            }
          }
          const s = nCore >= 20 ? cs : rs;
          blackness = Math.max(...s) > 0 ? Math.min(...s) / Math.max(...s) : 0;
        }
        [one, filled, strokeOnly, c].forEach((x) => x.delete());

        // Binder holes / dark blobs at the paper border: solid, compact, small, near the edge.
        const { rect, area } = cand;
        const solid = inkPixels > 0.85 * Math.max(1, area);
        const compact = Math.max(rect.width, rect.height) < minSide * 0.07 && rect.width < rect.height * 1.6 && rect.height < rect.width * 1.6;
        const hole = solid && compact && paper.distToEdge(rect.x + rect.width / 2, rect.y + rect.height / 2) < minSide * BORDER_BAND * 0.6;
        infos.push({ cand, inkPixels, meanV, drop: hole, blackness, weight, shadow });
      }
      // Corners / edges of a shadow or other big dark area: never ink, even if nothing else is left (the faint retries
      // and the safety net come next).
      for (let k = infos.length - 1; k >= 0; k--) {
        const f = infos[k];
        if (f.shadow <= SHADOW_RING) continue;
        const r = f.cand.rect;
        debugLog(`contour [${r.x},${r.y} ${r.width}x${r.height}] ring ${(f.shadow * 100).toFixed(0)}% as dark as its ink -> shadow, dropped`);
        infos.splice(k, 1);
      }
      if (strict && !infos.length) return null;
      if (black && infos.length) {
        // Stains, fold shadows, paper-edge lines, desk: grey-ish but less neutral than ink. The bar follows the drawing
        // itself (the contour with the most ink): black marker ~0.97 keeps it at BLACK_CONTOUR, a pencil drawing on
        // tinted paper (~0.9) lowers it so its own fainter strokes stay, never below BLACK_CONTOUR_MIN.
        const main = infos.reduce((a, b) => (b.weight > a.weight ? b : a));
        const bar = Math.min(BLACK_CONTOUR, Math.max(BLACK_CONTOUR_MIN, main.blackness - BLACK_BELOW_MAIN));
        for (const f of infos) {
          const r = f.cand.rect;
          debugLog(`contour [${r.x},${r.y} ${r.width}x${r.height}] black ${f.blackness.toFixed(2)} (bar ${bar.toFixed(2)})${f.blackness < bar ? ' -> dropped' : ''}`);
        }
        const kept = infos.filter((f) => f.blackness >= bar);
        // Nothing black left: strict mode gives up (the caller retries with any dark ink); otherwise keep them all
        // rather than return nothing.
        if (!kept.length && strict) return null;
        if (kept.length) infos.splice(0, infos.length, ...kept);
      }
      // Printed lines (notebook margin, a stray rule): long, straight, axis-aligned, thin, and much fainter in
      // max(R,G,B) than the darkest part of the drawing.
      const refV = Math.max(0, ...infos.filter((f) => !f.drop).map((f) => f.meanV));
      for (const f of infos) {
        const r = f.cand.rect;
        const long = Math.max(r.width, r.height);
        const across = Math.min(r.width, r.height);
        // Allow a few degrees of tilt (a rotated sheet), which widens the box of a long line.
        const lineLike = long >= minSide * PRINTED_LEN && across <= minSide * 0.04 + long * PRINTED_TILT && f.inkPixels <= long * LINE_THIN;
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
      return { ink, contours: out, inkMode: black ? 'black' : 'any' };
    }
  } finally {
    mats.forEach((m) => m.delete());
  }
}

type Track = <T>(m: T) => T;

// ---------------------------------------------------------------------------------------------------------------
// 2. Background / darkness

/**
 * Background = close (max then min) on a 1/BG_DOWNSCALE copy: removes thin ink, keeps shadows and light falloff.
 * Returns the darkness, the small background and the full-size background (valid until the Mats are freed).
 */
function darkness(cv: any, track: Track, ch: any, minSide: number, kernel0 = BG_KERNEL): { dark: Uint8Array; bgSmall: any; bg: Uint8Array } {
  const W = ch.cols;
  const H = ch.rows;
  const small = track(new cv.Mat());
  cv.resize(ch, small, new cv.Size(Math.max(16, Math.round(W / BG_DOWNSCALE)), Math.max(16, Math.round(H / BG_DOWNSCALE))), 0, 0, cv.INTER_AREA);
  const k = odd((minSide * kernel0) / BG_DOWNSCALE);
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
  return { dark, bgSmall, bg };
}

/**
 * Per pixel (only where luma darkness >= weakT): how evenly the ink darkens R, G and B, each relative to that
 * channel's own local background, as least / most darkened channel (0..255). Black / grey ink scales all channels
 * alike (~255) even under a warm lamp or on tinted paper; a blue pen hardly darkens B (~50). Mixing with the paper
 * (thin strokes, anti-aliasing) scales every channel's darkness alike, so the ratio holds on the rim of a stroke.
 */
function neutrality(rgba: Uint8Array, bgSmall: any, cand: Uint8Array, W: number, H: number): { neutral: Uint8Array; chan: Uint8Array } {
  // Background sampled bilinearly from the small closed copy, only at candidate pixels (a few % of the photo).
  const sw = bgSmall.cols, sh = bgSmall.rows;
  const bg = bgSmall.data as Uint8Array;
  const fx = sw / W, fy = sh / H;
  const out = new Uint8Array(W * H);
  /** Per-channel darkness (0..255, R G B interleaved), for per-contour sums in step 7. */
  const chan = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const v = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = v | 0, y1 = Math.min(sh - 1, y0 + 1), wy = v - y0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!cand[i]) continue;
      const u = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = u | 0, x1 = Math.min(sw - 1, x0 + 1), wx = u - x0;
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, e = (y1 * sw + x1) * 4;
      let mx = 0, mn = 1;
      for (let ch = 0; ch < 3; ch++) {
        let bgc = (bg[a + ch] * (1 - wx) + bg[b + ch] * wx) * (1 - wy) + (bg[c + ch] * (1 - wx) + bg[e + ch] * wx) * wy;
        if (bgc < 8) bgc = 8;
        let d = 1 - rgba[i * 4 + ch] / bgc;
        if (d < 0) d = 0;
        chan[i * 3 + ch] = Math.round(d * 255);
        if (d > mx) mx = d;
        if (d < mn) mn = d;
      }
      out[i] = mx > 0 ? Math.round((mn / mx) * 255) : 255;
    }
  }
  return { neutral: out, chan };
}

/**
 * Pixels of clearly coloured (neutral < colouredT) candidate ink in stroke-sized pieces: at least `minLong` long and
 * not touching the photo border (desk). Rules were already erased from `cand`.
 */
function colouredStrokes(cv: any, track: Track, candMat: any, neutral: Uint8Array, colouredT: number, minLong: number): number {
  const W = candMat.cols;
  const H = candMat.rows;
  const cand = candMat.data as Uint8Array;
  const m = track(new cv.Mat(H, W, cv.CV_8UC1));
  const md = m.data as Uint8Array;
  for (let i = 0; i < md.length; i++) md[i] = cand[i] && neutral[i] < colouredT ? 255 : 0;
  const labels = track(new cv.Mat());
  const stats = track(new cv.Mat());
  const cents = track(new cv.Mat());
  const n = cv.connectedComponentsWithStats(m, labels, stats, cents, 8, cv.CV_32S);
  const st = stats.data32S as Int32Array;
  let sum = 0;
  for (let l = 1; l < n; l++) {
    const x = st[l * 5], y = st[l * 5 + 1], w = st[l * 5 + 2], h = st[l * 5 + 3];
    if (x <= 0 || y <= 0 || x + w >= W || y + h >= H || Math.max(w, h) < minLong) continue;
    sum += st[l * 5 + 4];
  }
  return sum;
}

function debugLog(msg: string) {
  if (urlParams()?.has('debug')) console.log(`[vision] ${msg}`);
}

/** Weak / strong darkness thresholds from the paper noise (high percentile of darkness on the paper). */
function thresholds(dark: Uint8Array, paperMask: Uint8Array, stage: Stage): { weakT: number; strongT: number } {
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
  const [wk, wMin, wMax] = stage.weak;
  const [sk, sMin, sMax] = stage.strong;
  const weakT = clamp(noise * wk, wMin, wMax);
  const strongT = clamp(weakT * sk, sMin, sMax);
  debugLog(`stage ${stage.name}: paper noise ${(noise / 255).toFixed(3)}, weak ${(weakT / 255).toFixed(3)}, strong ${(strongT / 255).toFixed(3)}`);
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

interface ColorBg {
  /** Per-channel close (thin ink removed). */
  bg: any;
  /** Plain downscaled copy (keeps desk strips narrower than the close kernel). */
  raw: any;
  /** Close kernel size (small px). */
  k: number;
}

/** Background colour (per-channel close on a 1/BG_DOWNSCALE copy, same size as darkness()'s bgSmall). */
function backgroundColor(cv: any, track: Track, src: any, minSide: number): ColorBg {
  const small = track(new cv.Mat());
  cv.resize(src, small, new cv.Size(Math.max(16, Math.round(src.cols / BG_DOWNSCALE)), Math.max(16, Math.round(src.rows / BG_DOWNSCALE))), 0, 0, cv.INTER_AREA);
  const k = odd((minSide * BG_KERNEL) / BG_DOWNSCALE);
  const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
  const bg = track(new cv.Mat());
  cv.morphologyEx(small, bg, cv.MORPH_CLOSE, kernel);
  return { bg, raw: small, k };
}

const isWarm = (c: Uint8Array, p: number) => {
  const r = c[p], g = c[p + 1], bl = c[p + 2];
  const mx = r > g ? (r > bl ? r : bl) : g > bl ? g : bl;
  const mn = r < g ? (r < bl ? r : bl) : g < bl ? g : bl;
  return mx > 0 && (r - bl) >= mx * DESK_WARM && (mx - mn) >= mx * DESK_WARM;
};

/**
 * Desk by colour: wood / cork / cardboard is warm and saturated, while white paper stays near-grey even in a deep
 * shadow. Returns a 0/255 "paper-like" mask (small size), or null when there is no clearly coloured desk.
 */
function paperByColor(bgSmall: any, colorBg: ColorBg): Uint8Array | null {
  const sw = bgSmall.cols;
  const sh = bgSmall.rows;
  const n = sw * sh;
  const b = bgSmall.data as Uint8Array;
  const c = colorBg.bg.data as Uint8Array;
  const raw = colorBg.raw.data as Uint8Array;
  const desk = new Uint8Array(n);
  let nDesk = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) if (isWarm(c, p)) { desk[i] = 1; nDesk++; }
  // A desk strip narrower than the close kernel (paper almost filling the photo) vanishes from the closed
  // background, and the strip then reads as ink glued to every stroke that reaches the paper edge. Peel it from the
  // raw copy: walk in from each photo border while the pixels are desk-coloured, at most one kernel deep (ink
  // touching the photo border is rare; a warm-coloured stroke ending there loses only that short end).
  const peel = (i0: number, step: number) => {
    for (let s = 0, i = i0; s < colorBg.k && isWarm(raw, i * 4); s++, i += step) if (!desk[i]) { desk[i] = 1; nDesk++; }
  };
  for (let y = 0; y < sh; y++) { peel(y * sw, 1); peel(y * sw + sw - 1, -1); }
  for (let x = 0; x < sw; x++) { peel(x, sw); peel((sh - 1) * sw + x, -sw); }
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

function findPaper(cv: any, track: Track, bgSmall: any, colorBg: ColorBg, W: number, H: number): PaperInfo {
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
    // A desk meets the paper at a crisp edge; a shadow or light falloff across the sheet fades over many pixels
    // (even a hard shadow has a penumbra at this scale). If the bright / dark boundary is soft, the dark class is
    // shadowed paper: use the whole photo (darkness is relative to the local paper, so ink in the shadow is fine).
    if (boundarySharpness(b, bm0, sw, sh, hi - lo) < SHADOW_SOFT) return whole;
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

/**
 * Median brightness step across the bright-class boundary (away from the photo border), measured over 4 px and
 * relative to the bright / dark class contrast: ~1 for a crisp paper edge, ~0.1 for a shadow or light falloff.
 */
function boundarySharpness(b: Uint8Array, bin: Uint8Array, sw: number, sh: number, contrast: number): number {
  const steps: number[] = [];
  for (let y = 3; y < sh - 3; y++) {
    for (let x = 3; x < sw - 3; x++) {
      const i = y * sw + x;
      if (!bin[i] || (bin[i - 1] && bin[i + 1] && bin[i - sw] && bin[i + sw])) continue;
      steps.push(Math.max(Math.abs(b[i + 2] - b[i - 2]), Math.abs(b[i + 2 * sw] - b[i - 2 * sw])));
    }
  }
  if (!steps.length || contrast <= 0) return Infinity;
  steps.sort((p, q) => p - q);
  return steps[steps.length >> 1] / contrast;
}

/** Share of a contour's outline lying on the photo frame (within this many px of a photo side) at most... */
const FRAME_HUG = 0.25;
/** ...and the contour reaches at least this far (ratio of minSide) into the photo from every side it touches. */
const FRAME_REACH = 0.2;

/**
 * A drawing cut off by the photo frame, not desk: its outline (pts = x, y pairs, straight runs compressed) lies on the
 * frame for at most FRAME_HUG of its length, it touches one photo side (desk, shadows and objects come in at a
 * corner and touch two or three), and it reaches FRAME_REACH into the photo from it.
 */
function cutByFrame(pts: Int32Array, rect: { x: number; y: number; width: number; height: number }, W: number, H: number, minSide: number, perimeter: number): boolean {
  const sides = [rect.x <= 1, rect.y <= 1, rect.x + rect.width >= W - 1, rect.y + rect.height >= H - 1];
  const nSides = sides.filter(Boolean).length;
  if (nSides !== 1 || perimeter <= 0) return false;
  const reach = minSide * FRAME_REACH;
  if ((sides[0] || sides[2]) && rect.width < reach) return false;
  if ((sides[1] || sides[3]) && rect.height < reach) return false;
  const on = (x: number, y: number) => [x <= 2, y <= 2, x >= W - 3, y >= H - 3];
  let hug = 0;
  const n = pts.length / 2;
  for (let k = 0; k < n; k++) {
    const ax = pts[2 * k], ay = pts[2 * k + 1], bx = pts[(2 * ((k + 1) % n))], by = pts[2 * ((k + 1) % n) + 1];
    const a = on(ax, ay), b = on(bx, by);
    if (a.some((v, s) => v && b[s])) hug += Math.hypot(bx - ax, by - ay);
  }
  return hug <= FRAME_HUG * perimeter;
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
 * RULE_MIN_COUNT of them, erase each rule along its whole length - including the stretches where it was too broken
 * or too faint to be found, and its ends near the margin - wherever the pixels are about as faint as that rule.
 * Each rule is judged by its own darkness (rules get darker or lighter across a photo with the lighting), and a
 * long line much darker than the typical rule is the drawing (a ceiling, the ground), not a rule.
 */
function removeRuledLines(cv: any, track: Track, maskMat: any, dark: Uint8Array, paperWidth: number): boolean {
  const W = maskMat.cols;
  const H = maskMat.rows;
  // Half size: cheaper, and slightly tilted / curved 1 px lines are easier to catch.
  const hw = Math.round(W / 2);
  const hh = Math.round(H / 2);
  const half = track(new cv.Mat());
  cv.resize(maskMat, half, new cv.Size(hw, hh), 0, 0, cv.INTER_AREA);
  cv.threshold(half, half, 40, 255, cv.THRESH_BINARY);
  const hm = half.data as Uint8Array;
  const seg = Math.max(8, Math.round(Math.min(hw, hh) * 0.04));
  // Darkness of a half-size pixel = darkest of its 2x2 full-size pixels (a 1 px rule is in one of them).
  const darkAt = (x: number, y: number) => {
    const x0 = Math.min(W - 1, x * 2), y0 = Math.min(H - 1, y * 2);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    return Math.max(dark[y0 * W + x0], dark[y0 * W + x1], dark[y1 * W + x0], dark[y1 * W + x1]);
  };
  // Per half-size pixel: erase full-size ink below this darkness (0 = not on a rule).
  const thr = track(cv.Mat.zeros(hh, hw, cv.CV_8UC1));
  const t8 = thr.data as Uint8Array;
  const cap = Math.round(RULE_CAP * 255);
  let any = false;
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
    const lab = labels.data32S as Int32Array;
    const spanMin = (paperWidth / 2) * RULE_SPAN;
    interface Rule { l: number; median: number; p90: number; a: number; b: number }
    const idx = new Int32Array(n).fill(-1);
    const found: Rule[] = [];
    for (let l = 1; l < n; l++) {
      const span = horizontal ? st[l * 5 + 2] : st[l * 5 + 3];
      const across = horizontal ? st[l * 5 + 3] : st[l * 5 + 2];
      if (span >= spanMin && across < span * 0.12) { idx[l] = found.length; found.push({ l, median: 0, p90: 0, a: 0, b: 0 }); }
    }
    if (found.length < RULE_MIN_COUNT) continue;
    // Darkness profile and a straight-line fit (across = a * along + b) of the ink under each long run.
    const darks: number[][] = found.map(() => []);
    const sums = found.map(() => [0, 0, 0, 0, 0]); // n, su, sv, suu, suv
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        const i = y * hw + x;
        const k = idx[lab[i]];
        if (k < 0 || !hm[i]) continue;
        darks[k].push(darkAt(x, y));
        const u = horizontal ? x : y, v = horizontal ? y : x;
        const S = sums[k];
        S[0]++; S[1] += u; S[2] += v; S[3] += u * u; S[4] += u * v;
      }
    }
    found.forEach((r, k) => {
      const d = darks[k].sort((p, q) => p - q);
      r.median = d.length ? d[d.length >> 1] : 0;
      r.p90 = d.length ? d[Math.floor(d.length * 0.9)] : 0;
      const [cnt, su, sv, suu, suv] = sums[k];
      const den = cnt * suu - su * su;
      r.a = cnt > 1 && den ? (cnt * suv - su * sv) / den : 0;
      r.b = cnt ? (sv - r.a * su) / cnt : 0;
    });
    const medians = found.map((r) => r.median).sort((p, q) => p - q);
    const typical = medians[medians.length >> 1];
    // A long run much darker than the typical one is (mostly) drawn: a ceiling or ground line, maybe lying on a rule.
    const drawn = (r: Rule) => r.median > typical * RULE_DRAWN || r.median <= 0;
    const clean = found.filter((r) => !drawn(r));
    // Ruled / grid paper shows many rules; a few long lines (paper edges, a ground line) are not a ruling.
    if (clean.length < RULE_MIN_COUNT) continue;
    any = true;
    const p90s = clean.map((r) => r.p90).sort((p, q) => p - q);
    const tBase = Math.min(cap, Math.round(p90s[p90s.length >> 1] * RULE_FAINT));
    // Every straight run in this direction, short ones too (grid segments between strokes): the typical rule level.
    const lm0 = lines.data as Uint8Array;
    for (let i = 0; i < lm0.length; i++) if (lm0[i] && t8[i] < tBase) t8[i] = tBase;
    // Each long run at its own level (lighting varies across the photo; a drawn run keeps the typical level),
    // plus its straight extension across the sheet (broken / fainter stretches, ends near the margin).
    const tOf = (r: Rule) => (drawn(r) ? tBase : Math.max(tBase, Math.min(cap, Math.round(r.p90 * RULE_FAINT))));
    const byLabel = new Uint8Array(n);
    for (const r of found) byLabel[r.l] = tOf(r);
    for (let i = 0; i < lab.length; i++) if (byLabel[lab[i]] > t8[i]) t8[i] = byLabel[lab[i]];
    const lineMat = track(new cv.Mat(hh, hw, cv.CV_8UC1));
    for (const r of found) {
      const t = tOf(r);
      lineMat.setTo(new cv.Scalar(0));
      const end = horizontal ? hw : hh;
      const p1 = horizontal ? new cv.Point(0, Math.round(r.b)) : new cv.Point(Math.round(r.b), 0);
      const p2 = horizontal ? new cv.Point(end, Math.round(r.a * end + r.b)) : new cv.Point(Math.round(r.a * end + r.b), end);
      cv.line(lineMat, p1, p2, new cv.Scalar(255), RULE_EXTEND, cv.LINE_8);
      const lm = lineMat.data as Uint8Array;
      for (let i = 0; i < lm.length; i++) if (lm[i] && t8[i] < t) t8[i] = t;
    }
  }
  if (!any) return false;
  const full = track(new cv.Mat());
  cv.resize(thr, full, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST);
  const gk = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  cv.dilate(full, full, gk);
  const m = maskMat.data as Uint8Array;
  const f = full.data as Uint8Array;
  for (let i = 0; i < m.length; i++) if (m[i] && dark[i] < f[i]) m[i] = 0;
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
