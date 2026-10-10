// Gemini: annotated photo + contour list -> roles and constraints. The AI never invents coordinates.

import type { Analysis, Contour, DiagramType } from './types';

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY ?? '';
// Newest Flash first; older ones only if the newer model is unavailable for this key (see docs/research/gemini-json.md).
const MODELS = import.meta.env.VITE_GEMINI_MODEL ? [import.meta.env.VITE_GEMINI_MODEL] : ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
const TIMEOUT_MS = 12000;

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
explanation: one short friendly English sentence describing what will happen.
Reply with JSON only, shaped like:
{"diagram":"pendulum","confidence":0.9,"bodies":[{"contourId":0,"role":"bob","static":false,"mass":1.0}],"constraints":[{"type":"rope","from":0,"to":1}],"explanation":"..."}`;
}

export async function analyze(annotated: HTMLCanvasElement, contours: Contour[]): Promise<Analysis> {
  const override = new URLSearchParams(location.search).get('diagram') as DiagramType | null;
  if (override && DIAGRAMS.includes(override)) return heuristic(contours, override);
  if (!hasApiKey()) return heuristic(contours);

  const jpeg = annotated.toDataURL('image/jpeg', 0.85).split(',')[1];
  const text = prompt(contours, annotated.width, annotated.height);
  const deadline = Date.now() + TIMEOUT_MS;
  for (const model of MODELS) {
    // Structured output first; if the API rejects the schema field, retry with plain JSON mode.
    for (const withSchema of [true, false]) {
      if (Date.now() > deadline) return heuristic(contours);
      try {
        const raw = await callGemini(model, jpeg, text, withSchema, deadline - Date.now());
        return sanitize(raw, contours);
      } catch (err: any) {
        console.warn(`[ai] ${model} schema=${withSchema} failed`, err);
        if (err?.status === 404 || err?.status === 403) break; // model not available: next model
        if (err?.status !== 400) return heuristic(contours); // timeout / network: give up fast
      }
    }
  }
  return heuristic(contours);
}

async function callGemini(model: string, jpeg: string, text: string, withSchema: boolean, timeoutMs: number): Promise<any> {
  const generationConfig: Record<string, unknown> = { responseMimeType: 'application/json', temperature: 0.2 };
  if (withSchema) generationConfig.responseSchema = RESPONSE_SCHEMA;
  if (model.includes('2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else generationConfig.thinkingConfig = { thinkingLevel: 'LOW' };
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: jpeg } }, { text }] }],
    generationConfig,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
    const json = await res.json();
    const out: string = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    return JSON.parse(out.replace(/^```(?:json)?|```$/g, '').trim());
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
  // No roles at all: scene builders then use their own geometric guesses ("no role" branches).
  void contours;
  return {
    diagram,
    confidence: 0,
    bodies: [],
    constraints: [],
    params: { gravity: 9.8 },
    explanation: '',
    source: 'heuristic',
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---- Voice: spoken sentence + current params -> {"set": {...}} diff ----------------------------

export interface VoiceParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  unit?: string;
}

/**
 * Ask Gemini (text only) which parameters a spoken command changes. Returns only keys from `specs`,
 * clamped to their ranges. Throws on no key / network / bad JSON so the caller can use keyword parsing.
 */
export async function voiceToParams(
  utterance: string,
  current: Record<string, number>,
  specs: VoiceParamSpec[],
  timeoutMs = 6000,
): Promise<Record<string, number>> {
  if (!hasApiKey()) throw new Error('no api key');
  const text = `You control a physics simulation for students. Current parameters: ${JSON.stringify(current)}.
Parameters you may change (key, meaning, allowed range):
${specs.map((s) => `- ${s.key}: ${s.label}${s.unit ? ` in ${s.unit}` : ''}, ${s.min} to ${s.max}`).join('\n')}
Reference gravities in m/s²: Earth 9.8, Moon 1.62, Mars 3.71, Jupiter 24.8, zero gravity 0.
The student said: ${JSON.stringify(utterance)}
Reply with JSON only: {"set": {<key>: <new number>}} containing only the parameters that should change.
Relative requests ("double", "half", "a bit more") are relative to the current value. If nothing should change, reply {"set": {}}.`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error('no model');
  for (const model of MODELS) {
    if (Date.now() > deadline) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(500, deadline - Date.now()));
    try {
      const generationConfig: Record<string, unknown> = {
        responseMimeType: 'application/json',
        temperature: 0,
        thinkingConfig: model.includes('2.5') ? { thinkingBudget: 0 } : { thinkingLevel: 'LOW' },
      };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        lastErr = Object.assign(new Error(`Gemini ${res.status}`), { status: res.status });
        if (res.status === 404 || res.status === 403 || res.status === 400) continue; // try the next model
        throw lastErr;
      }
      const json = await res.json();
      const out: string = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      const raw = JSON.parse(out.replace(/^```(?:json)?|```$/g, '').trim());
      const set: Record<string, number> = {};
      for (const s of specs) {
        if (!raw?.set || !(s.key in raw.set)) continue;
        const v = Number(raw.set[s.key]);
        if (Number.isFinite(v)) set[s.key] = clamp(v, s.min, s.max);
      }
      return set;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
