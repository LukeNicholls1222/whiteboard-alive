// Gemini: annotated photo + contour list -> roles and constraints. The AI never invents coordinates.

import { guessDiagram } from './guess';
import type { Analysis, Contour, DiagramType } from './types';

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
/** Wait per model: the first one tried gets 9 s, later ones 6 s (all within TIMEOUT_MS). */
const FIRST_MODEL_MS = 9000;
const NEXT_MODEL_MS = 6000;

export const hasApiKey = () => API_KEY.length > 0;

const DIAGRAMS: DiagramType[] = ['pendulum', 'spring', 'incline', 'projectile', 'pulley', 'collision', 'fallback'];
const ROLES = ['pivot', 'rope', 'bob', 'spring', 'mass', 'incline', 'ground', 'wheel', 'cannon', 'arrow', 'projectile', 'label', 'other'];
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
incline (triangle/slope with a block or a ball on it; a ball rolls), projectile (cannon or arrow showing a launch),
pulley (wheel, rope, two weights), collision (two balls on a flat horizontal line with arrows showing motion; they
collide), or fallback if none fit. A ball on a slope is incline, not collision.
Assign a role to every contour id: pivot (fixed point or ceiling line), rope, bob, spring, mass, incline, ground,
wheel, cannon, arrow, projectile, label (any handwritten letters, words or numbers such as "1 m" or "2 kg";
never part of the machine, do not read their values), other. On an incline, the block or ball on the slope is mass
(or bob). For a collision, each ball is projectile, each motion arrow is arrow and the flat line they roll on is ground. Mark static=true for things that should not move (ceiling, ground, incline, wheel axle, cannon, label).
mass: relative mass (1.0 default; bigger drawn weights heavier). A single contour may contain several connected parts
(e.g. string and bob drawn touching); then give it the role of its main moving part.
constraints: connections between contour ids (rope / spring / pin). Use the same id for from and to if a part connects to itself.
explanation: one short friendly English sentence describing what will happen.
Reply with JSON only, shaped like:
{"diagram":"pendulum","confidence":0.9,"bodies":[{"contourId":0,"role":"bob","static":false,"mass":1.0}],"constraints":[{"type":"rope","from":0,"to":1}],"explanation":"..."}`;
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
  const models = MODELS.filter((m) => {
    const s = skipped(m);
    if (s) debugLog(`skip ${m} (${s.why})`);
    return !s;
  });
  // Every model is out of quota (or missing): don't spend the 20 s, keep the quick guess right away.
  if (!models.length) return null;
  const jpeg = annotated.toDataURL('image/jpeg', 0.85).split(',')[1];
  const text = prompt(contours, annotated.width, annotated.height);
  const deadline = Date.now() + TIMEOUT_MS;
  for (const [i, model] of models.entries()) {
    // The first model gets the longest wait; later ones less, so a hung model can't eat the whole budget.
    const perModel = i === 0 ? FIRST_MODEL_MS : NEXT_MODEL_MS;
    // Structured output first; if the API rejects the schema field, retry with plain JSON mode.
    for (const withSchema of [true, false]) {
      if (Date.now() > deadline) return null;
      try {
        const raw = await callGemini(model, jpeg, text, withSchema, Math.min(perModel, deadline - Date.now()));
        return sanitize(raw, contours);
      } catch (err: any) {
        console.warn(`[ai] ${model} schema=${withSchema} failed`, err);
        // 429 (quota) / 404 (no such model): remember it so the next photos skip this model.
        if (err?.status === 429 || err?.status === 404) markSkip(model, err.status, String(err.body ?? ''));
        // 400 = schema field rejected: retry this model without it. Anything else (busy 503/429,
        // missing model 404/403, timeout, network): move on to the next model while time remains.
        if (err?.status !== 400) break;
      }
    }
  }
  return null;
}

// ---- Models to skip: out of free-tier quota (429) or missing (404), remembered across reloads --------------

/** Free-tier quota is per model, ~20 requests/day, reset at 00:00 Pacific time. */
const SKIP_KEY = 'wa.ai.skip';
type Skip = { until: number; why: string };
const skipMemory: Record<string, Skip> = loadSkips();

const debugLog = (msg: string) => {
  if (new URLSearchParams(location.search).has('debug')) console.log(`[ai] ${msg}`);
};

function loadSkips(): Record<string, Skip> {
  try {
    if (new URLSearchParams(location.search).has('resetai')) {
      localStorage.removeItem(SKIP_KEY);
      console.log('[ai] resetai: forgot the skipped models');
      return {};
    }
    const raw = JSON.parse(localStorage.getItem(SKIP_KEY) ?? '{}');
    const out: Record<string, Skip> = {};
    for (const [m, s] of Object.entries(raw ?? {}))
      if (s && typeof (s as Skip).until === 'number' && (s as Skip).until > Date.now()) out[m] = s as Skip;
    return out;
  } catch {
    return {}; // no localStorage (private mode etc.): memory only
  }
}

function skipped(model: string): Skip | null {
  const s = skipMemory[model];
  if (!s) return null;
  if (s.until > Date.now()) return s;
  delete skipMemory[model];
  return null;
}

function markSkip(model: string, status: number, body: string) {
  let s: Skip;
  if (status === 404) s = { until: Date.now() + 24 * 3600_000, why: 'not found, 24 h' };
  else if (/PerDay/i.test(body)) s = { until: nextPacificMidnight(), why: 'quota until 00:00 PDT' };
  else if (/PerMinute/i.test(body)) s = { until: Date.now() + 60_000, why: 'per-minute quota, 60 s' };
  else s = { until: Date.now() + 10 * 60_000, why: '429, 10 min' };
  skipMemory[model] = s;
  debugLog(`${model} ${status}: skipping (${s.why})`);
  try {
    localStorage.setItem(SKIP_KEY, JSON.stringify(skipMemory));
  } catch {
    /* memory only */
  }
}

/** Next 00:00 in America/Los_Angeles (when the free-tier daily quota resets), as epoch ms. */
export function nextPacificMidnight(now = Date.now()): number {
  let msIntoDay: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(new Date(now));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    msIntoDay = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000);
    if (!Number.isFinite(msIntoDay)) throw new Error('bad time parts');
  } catch {
    msIntoDay = (((now - 7 * 3600_000) % 86400_000) + 86400_000) % 86400_000; // PDT = UTC-7
  }
  return now - msIntoDay + 86400_000;
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
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw Object.assign(new Error(`Gemini ${res.status}: ${errBody.slice(0, 300)}`), { status: res.status, body: errBody });
    }
    const json = await res.json();
    const out: string = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    return JSON.parse(out.replace(/^```(?:json)?|```$/g, '').trim());
  } finally {
    clearTimeout(timer);
  }
}

/** Never trust the model blindly: drop unknown ids, clamp numbers, default everything. */
export function sanitize(raw: any, contours: Contour[]): Analysis {
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
  // Numbers (lengths, masses, ...) are typed into "Your numbers", never read off the paper: nothing here sets them.
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

/** Whole budget for one spoken sentence, and the most the first model may take of it. */
const VOICE_MS = 6000;
const VOICE_FIRST_MODEL_MS = 4000;

/**
 * Ask Gemini (text only) which settings a spoken command changes; used only when the instant keyword parser
 * found nothing. Returns only keys from `specs`, as numbers in each spec's unit, NOT clamped: the caller checks
 * them against the same ranges as typed numbers. Skips models remembered as out of quota / missing (and remembers
 * new ones), at most `timeoutMs` in all. Throws on no key / ?offline / every model failing.
 */
export async function voiceToParams(
  utterance: string,
  current: Record<string, number>,
  specs: VoiceParamSpec[],
  timeoutMs = VOICE_MS,
): Promise<Record<string, number>> {
  if (!hasApiKey()) throw new Error('no api key');
  if (new URLSearchParams(location.search).has('offline')) throw new Error('offline');
  const models = MODELS.filter((m) => {
    const s = skipped(m);
    if (s) debugLog(`voice: skip ${m} (${s.why})`);
    return !s;
  });
  if (!models.length) throw new Error('every model is out of quota');
  const text = `You control a physics simulation for students. Current values: ${JSON.stringify(current)}.
Settings you may change (key, meaning, unit, allowed range):
${specs.map((s) => `- ${s.key}: ${s.label}${s.unit ? ` in ${s.unit}` : ''}, ${s.min} to ${s.max}`).join('\n')}
Reference gravities in m/s²: Earth 9.8, Moon 1.62, Mars 3.71, Jupiter 24.8, zero gravity 0.
The student said: ${JSON.stringify(utterance)}
Reply with JSON only: {"set": {<key>: <new number>}} containing only the settings that should change, converted to the
unit listed above (e.g. 50 cm for a length in m is 0.5). Switches are 1 = on, 0 = off.
Relative requests ("double", "half", "a bit more") are relative to the current value. If nothing should change, reply {"set": {}}.`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = new Error('no model');
  for (const [i, model] of models.entries()) {
    const left = deadline - Date.now();
    if (left < 300) break;
    const ctrl = new AbortController();
    // A hung first model must not eat the whole budget.
    const timer = setTimeout(() => ctrl.abort(), i === 0 ? Math.min(left, VOICE_FIRST_MODEL_MS) : left);
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
        const errBody = await res.text().catch(() => '');
        // 429 (quota) / 404 (no such model): the photo reader skips it from now on too.
        if (res.status === 429 || res.status === 404) markSkip(model, res.status, errBody);
        lastErr = Object.assign(new Error(`Gemini ${res.status}`), { status: res.status });
        continue; // busy, missing or refused: the next model while time remains
      }
      const json = await res.json();
      const out: string = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      const raw = JSON.parse(out.replace(/^```(?:json)?|```$/g, '').trim());
      const set: Record<string, number> = {};
      for (const s of specs) {
        if (!raw?.set || !(s.key in raw.set)) continue;
        const v = Number(raw.set[s.key]);
        if (Number.isFinite(v)) set[s.key] = v;
      }
      return set;
    } catch (err) {
      console.warn(`[voice] ${model} failed`, err);
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
