// Built-in examples: photos + the AI answer saved ahead of time, so the demo works without Wi-Fi or quota.

import type { Analysis, Contour } from './types';

export interface Example {
  name: string;
  title: string;
}

export const EXAMPLES: Example[] = [
  { name: 'pendulum-gen-01', title: 'Pendulum' },
  { name: 'spring-gen-01', title: 'Spring' },
  { name: 'incline-gen-01', title: 'Ramp' },
  { name: 'projectile-gen-01', title: 'Launch' },
  { name: 'pulley-gen-01', title: 'Pulley' },
  { name: 'pulley-gen-03', title: 'Big pulley' },
];

const BASE = `${import.meta.env.BASE_URL}examples/`;
export const exampleImage = (name: string) => `${BASE}${name}.jpg`;
export const exampleThumb = (name: string) => `${BASE}${name}-thumb.jpg`;

/** What the contours looked like when the answer was saved: count + bbox of every contour the answer mentions. */
export interface Fingerprint {
  count: number;
  boxes: Record<string, [number, number, number, number]>;
}

export function fingerprint(contours: Contour[], analysis: Analysis): Fingerprint {
  const ids = new Set<number>([
    ...analysis.bodies.map((b) => b.contourId),
    ...analysis.constraints.flatMap((c) => [c.from, c.to]),
  ]);
  const boxes: Fingerprint['boxes'] = {};
  for (const c of contours) if (ids.has(c.id)) boxes[c.id] = [c.bbox.x, c.bbox.y, c.bbox.w, c.bbox.h];
  return { count: contours.length, boxes };
}

/** True when today's contours carry the same ids at the same places as when the answer was saved. */
export function sameContours(fp: Fingerprint, contours: Contour[]): boolean {
  if (fp.count !== contours.length) return false;
  const byId = new Map(contours.map((c) => [c.id, c]));
  return Object.entries(fp.boxes).every(([id, [x, y, w, h]]) => {
    const c = byId.get(Number(id));
    if (!c) return false;
    const tol = 4;
    return Math.abs(c.bbox.x - x) <= tol && Math.abs(c.bbox.y - y) <= tol && Math.abs(c.bbox.w - w) <= tol && Math.abs(c.bbox.h - h) <= tol;
  });
}

let fingerprints: Promise<Record<string, Fingerprint>> | null = null;

/**
 * The saved answer for an example. If the contour ids no longer match (different OpenCV build, changed vision code),
 * keep only the diagram type and let the scene builders find the parts themselves.
 */
export async function cachedAnalysis(name: string, contours: Contour[]): Promise<Analysis> {
  fingerprints ??= fetch(`${BASE}fingerprints.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const [saved, fps] = await Promise.all([
    fetch(`${BASE}${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`example ${name}: ${r.status}`);
      return r.json() as Promise<Analysis>;
    }),
    fingerprints,
  ]);
  const analysis: Analysis = structuredClone({ ...saved, source: 'cached' as const });
  analysis.params = { ...analysis.params, gravity: Number(analysis.params?.gravity) || 9.8 };
  const fp = fps[name];
  if (!fp || !sameContours(fp, contours)) {
    console.warn(`[examples] ${name}: contour ids changed since the answer was saved; using the diagram type only`);
    analysis.bodies = [];
    analysis.constraints = [];
  }
  return analysis;
}
