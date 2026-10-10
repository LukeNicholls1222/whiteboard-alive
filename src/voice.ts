// Voice: Web Speech API -> text, and an offline keyword parser used when Gemini is unavailable.

export const PLANETS: Record<string, number> = {
  earth: 9.8,
  moon: 1.62,
  mars: 3.71,
  jupiter: 24.8,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const Recognition: any =
  typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;

export const speechSupported = () => !!Recognition;

/** Listen for one sentence (en-US). Resolves with the transcript; rejects on error / silence. */
export function listenOnce(onInterim?: (text: string) => void): { result: Promise<string>; stop: () => void } {
  const rec = new Recognition();
  rec.lang = 'en-US';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  let interim = '';
  const result = new Promise<string>((resolve, reject) => {
    rec.onresult = (e: any) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      onInterim?.((finalText + interim).trim());
    };
    rec.onerror = (e: any) => reject(new Error(e?.error || 'speech error'));
    rec.onend = () => {
      const text = (finalText || interim).trim();
      if (text) resolve(text);
      else reject(new Error('no-speech'));
    };
  });
  rec.start();
  return { result, stop: () => rec.stop() };
}

const WORD_NUMS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

/** A number spoken right after `word` (e.g. "gravity to 5", "friction 0.2", "speed of twelve"). */
function numberAfter(text: string, words: string): number | undefined {
  const m = text.match(new RegExp(`(?:${words})\\s+(?:to\\s+|of\\s+|at\\s+|is\\s+|=\\s*)?(-?\\d+(?:\\.\\d+)?|${Object.keys(WORD_NUMS).join('|')})`));
  if (!m) return undefined;
  return m[1] in WORD_NUMS ? WORD_NUMS[m[1]] : Number(m[1]);
}

/**
 * Offline fallback: understand simple commands without the AI.
 * Returns only the keys that change; keys not in `current` (not used by this scene) are ignored.
 */
export function parseKeywords(utterance: string, current: Record<string, number>): Record<string, number> {
  const t = ` ${utterance.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const set: Record<string, number> = {};
  const has = (re: RegExp) => re.test(t);
  const more = /\b(more|higher|stronger|heavier|increase|bigger|up)\b/;
  const less = /\b(less|lower|weaker|lighter|decrease|smaller|down|reduce)\b/;

  // --- gravity ---
  if ('gravity' in current) {
    const g = current.gravity;
    const n = numberAfter(t, 'gravity');
    const planet = Object.keys(PLANETS).find((p) => t.includes(` ${p} `) || t.includes(` ${p}s `));
    if (n !== undefined) set.gravity = n;
    else if (has(/\b(no|zero|without|turn off)\b[a-z ]*\bgravity\b|\bspace\b|\bweightless\b|\bzero g\b/)) set.gravity = 0;
    else if (planet) set.gravity = PLANETS[planet];
    else if (has(/\b(normal|reset|default|regular)\b/) && !has(/\b(friction|speed)\b/)) set.gravity = PLANETS.earth;
    else if (has(/\bgravity\b/)) {
      if (has(/\b(double|twice|two times)\b/)) set.gravity = g * 2;
      else if (has(/\b(triple|three times)\b/)) set.gravity = g * 3;
      else if (has(/\b(half|halve)\b/)) set.gravity = g / 2;
      else if (has(more)) set.gravity = g * 1.5;
      else if (has(less)) set.gravity = g / 1.5;
    }
  }

  // --- friction (incline) ---
  if ('friction' in current) {
    const f = current.friction;
    const n = numberAfter(t, 'friction');
    if (n !== undefined) set.friction = n;
    else if (has(/\b(no|zero|without|remove)\b[a-z ]*\bfriction\b|\bfrictionless\b|\bice\b|\bicy\b/)) set.friction = 0;
    else if (has(/\bslippery\b|\bslippier\b/)) set.friction = f / 2;
    else if (has(/\b(sticky|rough|rougher|grippy|sandpaper)\b/)) set.friction = Math.max(0.6, f * 2);
    else if (has(/\bfriction\b/)) {
      if (has(/\b(double|twice)\b/)) set.friction = f * 2;
      else if (has(/\b(half|halve)\b/)) set.friction = f / 2;
      else if (has(more)) set.friction = Math.max(f * 1.5, f + 0.1);
      else if (has(less)) set.friction = f / 1.5;
    }
  }

  // --- launch speed (projectile) ---
  if ('speed' in current) {
    const s = current.speed;
    const n = numberAfter(t, 'speed|velocity');
    if (n !== undefined) set.speed = n;
    else if (has(/\b(faster|harder|stronger shot|more power|further|farther)\b/)) set.speed = s * 1.4;
    else if (has(/\b(slower|softer|gentler|less power|shorter)\b/)) set.speed = s / 1.4;
    else if (has(/\b(speed|velocity)\b/)) {
      if (has(/\b(double|twice)\b/)) set.speed = s * 2;
      else if (has(/\b(half|halve)\b/)) set.speed = s / 2;
      else if (has(more)) set.speed = s * 1.4;
      else if (has(less)) set.speed = s / 1.4;
    }
  }
  return set;
}
