// Gemini: annotated photo + contour list -> roles and constraints. The AI never invents coordinates.

import type { Analysis, Contour, DiagramType } from './types';

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY ?? '';
const MODEL = import.meta.env.VITE_GEMINI_MODEL || 'gemini-2.5-flash';
const TIMEOUT_MS = 20000;

export const hasApiKey = () => API_KEY.length > 0;

const DIAGRAMS: DiagramType[] = ['pendulum', 'spring', 'incline', 'projectile', 'pulley', 'fallback'];
const ROLES = ['pivot', 'rope', 'bob', 'spring', 'mass', 'incline', 'ground', 'wheel', 'cannon', 'arrow', 'projectile', 'other'];

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    diagram: { type: 'STRING', enum: DIAGRAMS },
    confidence: { type: 'NUMBER' },
    bodies: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          contourId: { type: 'INTEGER' },
          role: { type: 'STRING', enum: ROLES },
          static: { type: 'BOOLEAN' },
          mass: { type: 'NUMBER' },
        },
        required: ['contourId', 'role', 'static', 'mass'],
      },
    },
    constraints: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['rope', 'spring', 'pin'] },
          from: { type: 'INTEGER' },
          to: { type: 'INTEGER' },
        },
        required: ['type', 'from', 'to'],
      },
    },
    explanation: { type: 'STRING' },
  },
  required: ['diagram', 'confidence', 'bodies', 'constraints', 'explanation'],
};

function prompt(contours: Contour[], w: number, h: number): string {
  const list = contours.map((c) => ({
    id: c.id,
    bbox: [c.bbox.x, c.bbox.y, c.bbox.w, c.bbox.h],
    centroid: [Math.round(c.centroid.x), Math.round(c.centroid.y)],
    inkPixels: c.inkPixels,
    closedLoop: c.hasHole,
    outline: c.points.slice(0, 24).map((p) => [p.x, p.y]),
  }));
  return `You are looking at a hand-drawn physics diagram on paper (${w}x${h} px, y grows downward).
Each ink stroke group was detected by computer vision and is outlined in the image with its id label "#N".
Detected contours (pixel coordinates are ground truth; do not invent new coordinates):
${JSON.stringify(list)}

Classify the diagram as exactly one of: pendulum (fixed point/ceiling, string, bob), spring (zigzag line + block),
incline (triangle/slope + block), projectile (cannon or arrow showing a launch), pulley (wheel, rope, two weights),
or fallback if none fit.
Assign a role to every contour id: pivot (fixed point or ceiling line), rope, bob, spring, mass, incline, ground,
wheel, cannon, arrow, projectile, other. Mark static=true for things that should not move (ceiling, ground, incline, wheel axle, cannon).
mass: relative mass (1.0 default; bigger drawn weights heavier). A single contour may contain several connected parts
(e.g. string and bob drawn touching); then give it the role of its main moving part.
constraints: connections between contour ids (rope / spring / pin). Use the same id for from and to if a part connects to itself.
explanation: one short friendly English sentence describing what will happen.`;
}

export async function analyze(annotated: HTMLCanvasElement, contours: Contour[]): Promise<Analysis> {
  const override = new URLSearchParams(location.search).get('diagram') as DiagramType | null;
  if (override && DIAGRAMS.includes(override)) return heuristic(contours, override);
  if (!hasApiKey()) return heuristic(contours);

  const jpeg = annotated.toDataURL('image/jpeg', 0.85).split(',')[1];
  const body = {
    contents: [
      {
        parts: [{ inline_data: { mime_type: 'image/jpeg', data: jpeg } }, { text: prompt(contours, annotated.width, annotated.height) }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
      ...(MODEL.includes('2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text: string = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    return sanitize(JSON.parse(text), contours);
  } catch (err) {
    console.warn('[ai] falling back to heuristic', err);
    return heuristic(contours);
  } finally {
    clearTimeout(timer);
  }
}

/** Never trust the model blindly: drop unknown ids, clamp numbers, default everything. */
function sanitize(raw: any, contours: Contour[]): Analysis {
  const ids = new Set(contours.map((c) => c.id));
  const diagram: DiagramType = DIAGRAMS.includes(raw?.diagram) ? raw.diagram : 'fallback';
  const bodies = (Array.isArray(raw?.bodies) ? raw.bodies : [])
    .filter((b: any) => ids.has(b?.contourId))
    .map((b: any) => ({
      contourId: b.contourId,
      role: ROLES.includes(b.role) ? b.role : 'other',
      static: !!b.static,
      mass: clamp(Number(b.mass) || 1, 0.1, 10),
    }));
  const constraints = (Array.isArray(raw?.constraints) ? raw.constraints : []).filter(
    (c: any) => ids.has(c?.from) && ids.has(c?.to) && ['rope', 'spring', 'pin'].includes(c?.type),
  );
  return {
    diagram,
    confidence: clamp(Number(raw?.confidence) || 0, 0, 1),
    bodies,
    constraints,
    params: { gravity: 9.8 },
    explanation: typeof raw?.explanation === 'string' ? raw.explanation : '',
    source: 'gemini',
  };
}

/** Offline guess so the pipeline always produces something that moves. */
function heuristic(contours: Contour[], diagram: DiagramType = 'fallback'): Analysis {
  const sorted = [...contours].sort((a, b) => a.bbox.y - b.bbox.y);
  return {
    diagram,
    confidence: 0,
    bodies: sorted.map((c) => ({ contourId: c.id, role: 'other', static: false, mass: 1 })),
    constraints: [],
    params: { gravity: 9.8 },
    explanation: '',
    source: 'heuristic',
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
