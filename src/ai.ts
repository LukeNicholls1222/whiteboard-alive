// Gemini: annotated photo + contour list -> roles and constraints. The AI never invents coordinates.

import { guessDiagram } from './guess';
import type { Analysis, Annotation, Contour, DiagramType, PartName, Quantity } from './types';

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY ?? '';
// Newest Flash first; older ones only if the newer model is unavailable for this key (see docs/research/gemini-json.md).
const MODELS = import.meta.env.VITE_GEMINI_MODEL ? [import.meta.env.VITE_GEMINI_MODEL] : [
      // The free tier allows ~20 requests/day per model, so keep a long chain of independent quotas.
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'gemini-flash-latest',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ];
const TIMEOUT_MS = 20000;

export const hasApiKey = () => API_KEY.length > 0;

const DIAGRAMS: DiagramType[] = ['pendulum', 'spring', 'incline', 'projectile', 'pulley', 'fallback'];
const ROLES = ['pivot', 'rope', 'bob', 'spring', 'mass', 'incline', 'ground', 'wheel', 'cannon', 'arrow', 'projectile', 'label', 'other'];
const QUANTITIES: Quantity[] = ['length', 'mass', 'angle', 'speed', 'friction', 'spring_constant'];
const PARTS: PartName[] = ['string', 'bob', 'spring', 'block', 'ramp', 'ground', 'ball', 'arrow', 'left weight', 'right weight', 'wheel'];
/** Names a model may use instead of the fixed part list (only matters in plain-JSON mode, without the schema). */
const PART_ALIASES: Record<string, PartName> = {
  rope: 'string',
  rod: 'string',
  box: 'block',
  mass: 'block',
  weight: 'block',
  incline: 'ramp',
  slope: 'ramp',
  floor: 'ground',
  projectile: 'ball',
  pulley: 'wheel',
  'left mass': 'left weight',
  'right mass': 'right weight',
  'left block': 'left weight',
  'right block': 'right weight',
};

/** Written unit (lower case, no spaces) -> factor to this app's unit, per quantity. Unknown units are dropped. */
const UNIT_FACTORS: Record<Quantity, Record<string, number>> = {
  length: { m: 1, meter: 1, meters: 1, metre: 1, metres: 1, cm: 0.01, mm: 0.001, km: 1000, in: 0.0254, inch: 0.0254, inches: 0.0254, ft: 0.3048, foot: 0.3048, feet: 0.3048 },
  mass: { kg: 1, kgs: 1, kilogram: 1, kilograms: 1, g: 0.001, gram: 0.001, grams: 0.001, lb: 0.45359237, lbs: 0.45359237 },
  angle: { '': 1, '°': 1, deg: 1, degree: 1, degrees: 1, rad: 180 / Math.PI },
  speed: { 'm/s': 1, mps: 1, 'm/sec': 1, 'cm/s': 0.01, 'km/h': 1 / 3.6, 'km/hr': 1 / 3.6, kph: 1 / 3.6, kmh: 1 / 3.6, mph: 0.44704, 'ft/s': 0.3048 },
  friction: { '': 1, '-': 1, none: 1, 'μ': 1, mu: 1 },
  spring_constant: { 'n/m': 1, 'n/cm': 100, 'n/mm': 1000, 'kn/m': 1000 },
};
/** Plausible range per quantity after normalising (friction matches the slider). Outside = misread, dropped. */
const RANGES: Record<Quantity, [number, number]> = {
  length: [0.005, 1000],
  mass: [0.001, 10000],
  angle: [1, 89],
  speed: [0.05, 300],
  friction: [0, 1.5],
  spring_constant: [0.1, 1e6],
};
const SI_UNIT: Record<Quantity, string> = { length: 'm', mass: 'kg', angle: '°', speed: 'm/s', friction: '', spring_constant: 'N/m' };

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
    annotations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          quantity: { type: 'STRING', enum: QUANTITIES },
          value: { type: 'NUMBER' },
          unit: { type: 'STRING' },
          part: { type: 'STRING', enum: PARTS },
        },
        required: ['text', 'quantity', 'value', 'unit', 'part'],
      },
    },
    explanation: { type: 'STRING' },
  },
  required: ['diagram', 'confidence', 'bodies', 'constraints', 'annotations', 'explanation'],
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
wheel, cannon, arrow, projectile, label (handwritten letters or numbers such as "1 m", "2 kg", "30°", "μ = 0.2";
never part of the machine), other. Mark static=true for things that should not move (ceiling, ground, incline, wheel axle, cannon, label).
mass: relative mass (1.0 default; bigger drawn weights heavier). A single contour may contain several connected parts
(e.g. string and bob drawn touching); then give it the role of its main moving part.
constraints: connections between contour ids (rope / spring / pin). Use the same id for from and to if a part connects to itself.
annotations: values the student wrote next to parts, e.g. "1 m" beside the string, "2 kg" on a box, "30°" at the ramp
corner, "μ = 0.2" on the slope, "10 m/s" by the launch arrow, "3 kg" and "1 kg" on the two pulley weights, "k = 20 N/m"
by the spring. One item per written value: text (exactly as written), quantity (length, mass, angle, speed, friction,
spring_constant), value (the number as written), unit (as written: m, cm, mm, kg, g, deg, m/s, km/h, N/m; "" for a
friction coefficient), part (what it labels: string, bob, spring, block, ramp, ground, ball, arrow, left weight,
right weight, wheel; left/right = which side of the pulley wheel it hangs on). Only values you can actually read;
use [] if nothing is written. A written value is never a coordinate.
explanation: one short friendly English sentence describing what will happen.
Reply with JSON only, shaped like:
{"diagram":"pendulum","confidence":0.9,"bodies":[{"contourId":0,"role":"bob","static":false,"mass":1.0}],"constraints":[{"type":"rope","from":0,"to":1}],"annotations":[],"explanation":"..."}`;
}

/**
 * Where this page's analysis comes from: a diagram forced with ?diagram=..., the shape-based guess only
 * (?offline or no key), or Gemini (with the guess shown while it thinks, see main.ts).
 */
export type AIPlan = { kind: 'forced'; diagram: DiagramType } | { kind: 'offline' } | { kind: 'gemini' };

export function aiPlan(): AIPlan {
  const q = new URLSearchParams(location.search);
  const override = q.get('diagram') as DiagramType | null;
  if (override && DIAGRAMS.includes(override)) return { kind: 'forced', diagram: override };
  // ?offline skips Gemini (saves the small free-tier quota during testing and shows the shape-based guess).
  if (!hasApiKey() || q.has('offline')) return { kind: 'offline' };
  return { kind: 'gemini' };
}

export async function analyze(annotated: HTMLCanvasElement, contours: Contour[]): Promise<Analysis> {
  const plan = aiPlan();
  if (plan.kind === 'forced') return heuristic(contours, annotated, plan.diagram);
  if (plan.kind === 'offline') return heuristic(contours, annotated);
  return (await askGemini(annotated, contours)) ?? heuristic(contours, annotated);
}

/** Gemini's reading of the drawing, or null if every model failed or the time ran out (never throws). */
export async function askGemini(annotated: HTMLCanvasElement, contours: Contour[]): Promise<Analysis | null> {
  const jpeg = annotated.toDataURL('image/jpeg', 0.85).split(',')[1];
  const text = prompt(contours, annotated.width, annotated.height);
  const deadline = Date.now() + TIMEOUT_MS;
  for (const model of MODELS) {
    // Structured output first; if the API rejects the schema field, retry with plain JSON mode.
    for (const withSchema of [true, false]) {
      if (Date.now() > deadline) return null;
      try {
        const raw = await callGemini(model, jpeg, text, withSchema, Math.min(9000, deadline - Date.now()));
        return sanitize(raw, contours);
      } catch (err: any) {
        console.warn(`[ai] ${model} schema=${withSchema} failed`, err);
        // 400 = schema field rejected: retry this model without it. Anything else (busy 503/429,
        // missing model 404/403, timeout, network): move on to the next model while time remains.
        if (err?.status !== 400) break;
      }
    }
  }
  return null;
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
  const annotations = (Array.isArray(raw?.annotations) ? raw.annotations : [])
    .map(normalizeNote)
    .filter((a: Annotation | null): a is Annotation => !!a);
  // Written values that have a slider go straight into the params the scene is built with.
  const params: Analysis['params'] = { gravity: 9.8 };
  const mu = annotations.find((a: Annotation) => a.quantity === 'friction');
  if (mu) params.friction = mu.value;
  const v0 = annotations.find((a: Annotation) => a.quantity === 'speed');
  if (v0) params.speed = v0.value; // m/s; the projectile converts it to px per step
  return {
    diagram,
    confidence: clamp(Number(raw?.confidence) || 0, 0, 1),
    bodies,
    constraints,
    params,
    explanation: typeof raw?.explanation === 'string' ? raw.explanation : '',
    source: 'gemini',
    annotations,
  };
}

/**
 * One handwritten value -> this app's units (m, kg, °, m/s, μ, N/m), or null if the quantity, part or unit is
 * unknown or the value is implausible (a misread "1 m" must not turn a pendulum into a 1000 m one).
 */
export function normalizeNote(a: any): Annotation | null {
  if (!a || typeof a !== 'object') return null;
  const quantity: Quantity | null = QUANTITIES.includes(a.quantity) ? a.quantity : null;
  const partName = String(a.part ?? '').trim().toLowerCase();
  const part: PartName | undefined = (PARTS as string[]).includes(partName) ? (partName as PartName) : PART_ALIASES[partName];
  const value = Number(a.value);
  if (!quantity || !part || !Number.isFinite(value)) return null;
  const text = String(a.text ?? '').slice(0, 40);
  const clean = (u: string) => u.toLowerCase().replace(/\s+/g, '').replace(/µ/g, 'μ').replace(/\.$/, '').replace(/^n\/a$/, '');
  const table = UNIT_FACTORS[quantity];
  let unit = clean(String(a.unit ?? ''));
  // No unit given but the text has one ("L = 30 cm"): take it from the text.
  if (!unit && !('' in table)) unit = clean(text.replace(/^[^=]*=/, '').trim().replace(/^-?[\d.,]+/, ''));
  const factor = table[unit];
  if (factor === undefined) return null;
  const v = value * factor;
  const [lo, hi] = RANGES[quantity];
  if (!(v >= lo && v <= hi)) return null;
  return { text, quantity, value: v, unit: SI_UNIT[quantity], part };
}

/**
 * Shape-based guess without calling Gemini (~0.2 s): what runs while Gemini thinks, and the answer if it fails
 * or a built-in example's saved answer cannot be read.
 */
export const offlineAnalysis = (annotated: HTMLCanvasElement, contours: Contour[]) => heuristic(contours, annotated);

/**
 * Offline analysis (no key, AI quota used up, AI busy, or ?diagram=... forced). The diagram type comes from
 * shape features (src/guess.ts) unless forced; roles stay empty so scene builders use their geometric guesses.
 */
function heuristic(contours: Contour[], annotated: HTMLCanvasElement, forced?: DiagramType): Analysis {
  let diagram: DiagramType = forced ?? 'fallback';
  let confidence = 0;
  if (!forced) {
    try {
      const g = guessDiagram({ width: annotated.width, height: annotated.height, ink: inkFromAnnotated(annotated, contours), contours });
      console.log(`[ai] offline guess: ${g.diagram} (${g.confidence}) ${g.why}`);
      diagram = g.diagram;
      confidence = g.confidence;
    } catch (err) {
      console.warn('[ai] offline guess failed', err);
    }
  }
  return {
    diagram,
    confidence,
    bodies: [],
    constraints: [],
    params: { gravity: 9.8 },
    explanation: '',
    source: 'heuristic',
  };
}

/**
 * Recover the ink mask from the annotated image: the cleaned paper is exactly PAPER_COLOR wherever there is no ink,
 * so non-paper pixels inside a contour's bbox are ink - except the id boxes and "#N" labels (see annotate() in
 * vision.ts), which can land inside a neighbour's bbox. Those are redrawn on a scratch canvas and masked out.
 */
function inkFromAnnotated(annotated: HTMLCanvasElement, contours: Contour[]): Uint8Array {
  const W = annotated.width, H = annotated.height;
  const d = annotated.getContext('2d')!.getImageData(0, 0, W, H).data;
  const marks = document.createElement('canvas');
  marks.width = W;
  marks.height = H;
  const mctx = marks.getContext('2d')!;
  mctx.strokeStyle = mctx.fillStyle = '#000';
  mctx.lineWidth = 4;
  mctx.font = 'bold 22px sans-serif';
  for (const c of contours) {
    mctx.strokeRect(c.bbox.x - 3, c.bbox.y - 3, c.bbox.w + 6, c.bbox.h + 6);
    const y = Math.max(20, c.bbox.y - 6);
    mctx.fillRect(c.bbox.x - 2, y - 22, mctx.measureText(`#${c.id}`).width + 4, 28);
  }
  const m = mctx.getImageData(0, 0, W, H).data;
  const ink = new Uint8Array(W * H);
  for (const c of contours) {
    const x0 = Math.max(0, c.bbox.x), x1 = Math.min(W, c.bbox.x + c.bbox.w);
    const y0 = Math.max(0, c.bbox.y), y1 = Math.min(H, c.bbox.y + c.bbox.h);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * W + x, p = i * 4;
        if (!m[p + 3] && (d[p] !== 251 || d[p + 1] !== 250 || d[p + 2] !== 246)) ink[i] = 255;
      }
  }
  return ink;
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
