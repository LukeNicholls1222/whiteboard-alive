// Photo -> ink mask -> contours. Everything here runs on-device with OpenCV.js.

import type { Contour, Point } from './types';

declare global {
  interface Window {
    cv: any;
    Module: any;
  }
}

/** Longest side of the working image. Keeps OpenCV and the physics fast on phones. */
export const WORK_SIZE = 960;

let cvReady: Promise<any> | null = null;

export function loadOpenCV(): Promise<any> {
  if (cvReady) return cvReady;
  cvReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${import.meta.env.BASE_URL}opencv.js`;
    script.async = true;
    script.onload = () => {
      const cv = window.cv;
      if (cv && typeof cv.then === 'function') {
        cv.then((m: any) => {
          window.cv = m;
          resolve(m);
        });
      } else if (cv && cv.Mat) {
        resolve(cv);
      } else {
        cv.onRuntimeInitialized = () => resolve(window.cv);
      }
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
  const W = photo.width;
  const H = photo.height;
  const minSide = Math.min(W, H);
  const mats: any[] = [];
  const track = <T>(m: T): T => {
    mats.push(m);
    return m;
  };

  try {
    const src = track(cv.imread(photo));
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = track(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    // Adaptive threshold copes with uneven light and soft shadows.
    let block = Math.round(minSide / 20) | 1;
    if (block < 15) block = 15;
    const bin = track(new cv.Mat());
    cv.adaptiveThreshold(blur, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, block, 12);

    // Close small gaps in faint / broken strokes.
    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    const closed = track(new cv.Mat());
    cv.morphologyEx(bin, closed, cv.MORPH_CLOSE, kernel);

    const contoursVec = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(closed, contoursVec, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE);

    // Keep outer contours that are big enough and are not the paper edge.
    const minArea = (minSide * minSide) / 2500;
    const keepMask = track(cv.Mat.zeros(H, W, cv.CV_8UC1));
    const out: Contour[] = [];
    const hier = hierarchy.data32S;
    for (let i = 0; i < contoursVec.size(); i++) {
      const parent = hier[i * 4 + 3];
      if (parent !== -1) continue;
      const c = contoursVec.get(i);
      const rect = cv.boundingRect(c);
      const area = cv.contourArea(c);
      const touchesEdge = rect.x <= 1 || rect.y <= 1 || rect.x + rect.width >= W - 1 || rect.y + rect.height >= H - 1;
      const huge = rect.width > W * 0.9 || rect.height > H * 0.9;
      const tiny = Math.max(rect.width, rect.height) < minSide / 30 || (area < minArea && Math.max(rect.width, rect.height) < minSide / 12);
      if (tiny || (touchesEdge && huge)) {
        c.delete();
        continue;
      }
      const hasHole = hier[i * 4 + 2] !== -1;

      // Ink pixels belonging to this contour.
      const one = new cv.MatVector();
      one.push_back(c);
      const filled = cv.Mat.zeros(H, W, cv.CV_8UC1);
      cv.drawContours(filled, one, 0, new cv.Scalar(255), cv.FILLED);
      const strokeOnly = new cv.Mat();
      cv.bitwise_and(filled, closed, strokeOnly);
      const inkPixels = cv.countNonZero(strokeOnly);
      cv.drawContours(keepMask, one, 0, new cv.Scalar(255), cv.FILLED);

      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, Math.max(2, minSide / 200), true);
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
        hasHole,
      });
      [one, filled, strokeOnly, approx, hullMat, c].forEach((x) => x.delete());
    }

    // Ink mask restricted to kept contours.
    const inkMat = track(new cv.Mat());
    cv.bitwise_and(closed, keepMask, inkMat);
    const ink = new Uint8Array(inkMat.data);

    return { width: W, height: H, ink, paper: makePaper(photo, ink), contours: out };
  } finally {
    mats.forEach((m) => m.delete());
  }
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
