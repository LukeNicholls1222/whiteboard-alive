// Voice: Web Speech API -> text, and an instant offline parser for spoken settings ("make the string 1 meter").
// The parser runs first (free, no network); Gemini is asked only when it finds nothing (controls.ts).
// No runtime imports, so the parser can be tested in plain Node.

import type { EntryKey } from './entries';

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

// ---- What can be set -----------------------------------------------------------------------------------

/** Slider keys (gravity, friction, speed) and "Your numbers" keys. */
export type VoiceKey = 'gravity' | 'friction' | 'speed' | EntryKey;

/** Something the scene on screen lets you change, with its current value (NaN = unknown) and its range. */
export interface VoiceTarget {
  key: VoiceKey;
  value: number;
  min: number;
  max: number;
}

export interface VoiceContext {
  /** Sliders and number boxes on screen. A setting that is not listed is never changed. */
  targets: VoiceTarget[];
  /** The scene has an air resistance switch. */
  air: boolean;
  /** There are number boxes to reset. */
  numbers: boolean;
}

export interface VoiceResult {
  /** New values in the slider's / box's own unit (explicit ones are not range-checked: the caller refuses them). */
  set: Partial<Record<VoiceKey, number>>;
  air?: boolean;
  arrows?: boolean;
  /** Empty "Your numbers". */
  reset?: boolean;
  /** Short reasons something heard could not be done ("Say which weight: left or right."). */
  problems: string[];
}

export const isEmptyResult = (r: VoiceResult) =>
  !Object.keys(r.set).length && r.air === undefined && r.arrows === undefined && !r.reset && !r.problems.length;

// ---- Words -> numbers ----------------------------------------------------------------------------------

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const DIGIT: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
/** "this one", "the left one": a pronoun, not the number 1. */
const ONE_PRONOUN = new Set(
  'this that the which other each every any another left right heavy heavier light lighter big bigger small smaller red blue first last new no'.split(' '),
);
const isDigits = (s: string | undefined) => !!s && /^\d+(\.\d+)?$/.test(s);
const isWordNum = (s: string | undefined) => !!s && (s in SMALL || s in TENS);

/** A spoken number starting at token i ("forty five", "two point five", "one and a half", "a hundred", "12.5"). */
function readNumber(t: string[], i: number, prev: string | undefined): { value: number; end: number } | null {
  let j = i;
  let total = 0;
  let cur = 0;
  let any = false;
  if (t[i] === 'one' && prev && ONE_PRONOUN.has(prev)) return null;
  if (isDigits(t[j])) {
    cur = Number(t[j++]);
    any = true;
  } else if (t[j] === 'a' && (t[j + 1] === 'hundred' || t[j + 1] === 'thousand')) {
    cur = t[j + 1] === 'hundred' ? 100 : 1000;
    j += 2;
    any = true;
  } else {
    while (j < t.length) {
      const w = t[j];
      if (w in SMALL) cur += SMALL[w];
      else if (w in TENS) cur += TENS[w];
      else if (w === 'hundred' && any) cur *= 100;
      else if (w === 'thousand' && any) {
        total += cur * 1000;
        cur = 0;
      } else if (w === 'and' && any && t[j - 1] === 'hundred' && isWordNum(t[j + 1])) {
        /* "one hundred and twenty" */
      } else break;
      any = true;
      j++;
    }
  }
  let value = total + cur;
  // "two point five", "point five", "1 point 25"
  if (t[j] === 'point' && (t[j + 1] in DIGIT || /^\d+$/.test(t[j + 1] ?? ''))) {
    let frac = '';
    j++;
    while (j < t.length && (t[j] in DIGIT || /^\d+$/.test(t[j]))) frac += t[j] in DIGIT ? DIGIT[t[j++]] : t[j++];
    value = Number(`${any ? value : 0}.${frac}`);
    any = true;
  }
  if (!any) return null;
  if (t[j] === 'and' && t[j + 1] === 'a' && (t[j + 2] === 'half' || t[j + 2] === 'quarter')) {
    value += t[j + 2] === 'half' ? 0.5 : 0.25;
    j += 3;
  } else if (value === 1 && t[j] === 'half') {
    value = 0.5; // "one half"
    j++;
  }
  return { value, end: j };
}

// ---- Units ---------------------------------------------------------------------------------------------

type Cat = 'length' | 'mass' | 'angle' | 'speed' | 'stiffness' | 'accel' | 'ratio' | 'times';

const LENGTH: Record<string, number> = {
  mm: 0.001, millimeter: 0.001, millimeters: 0.001, millimetre: 0.001, millimetres: 0.001,
  cm: 0.01, cms: 0.01, centimeter: 0.01, centimeters: 0.01, centimetre: 0.01, centimetres: 0.01,
  m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
  km: 1000, kilometer: 1000, kilometers: 1000, kilometre: 1000, kilometres: 1000,
  ft: 0.3048, foot: 0.3048, feet: 0.3048, inch: 0.0254, inches: 0.0254, yard: 0.9144, yards: 0.9144,
  mile: 1609.34, miles: 1609.34,
};
const MASS: Record<string, number> = {
  g: 0.001, gram: 0.001, grams: 0.001, gramme: 0.001, grammes: 0.001,
  kg: 1, kgs: 1, kilo: 1, kilos: 1, kilogram: 1, kilograms: 1, kilogramme: 1, kilogrammes: 1,
  lb: 0.45359, lbs: 0.45359, pound: 0.45359, pounds: 0.45359,
};
const SINGLE: Record<string, [Cat, number]> = {
  degree: ['angle', 1], degrees: ['angle', 1], deg: ['angle', 1], degs: ['angle', 1],
  mps: ['speed', 1], cmps: ['speed', 0.01], kmh: ['speed', 1 / 3.6], kph: ['speed', 1 / 3.6], mph: ['speed', 0.44704],
  mpss: ['accel', 1], npm: ['stiffness', 1], newton: ['stiffness', 1], newtons: ['stiffness', 1],
  percent: ['ratio', 0.01], times: ['times', 1], x: ['times', 1],
};
const PER = new Set(['per', 'a', 'an', 'every']);
const SECOND = new Set(['second', 'seconds', 'sec', 's']);
const HOUR = new Set(['hour', 'hours', 'hr', 'h']);

/** A unit starting at token j: "cm", "meters per second", "kilometers an hour", "newtons per meter", "degrees". */
function readUnit(t: string[], j: number): { cat: Cat; factor: number; end: number; word: boolean } | null {
  const w = t[j];
  if (!w) return null;
  if (w in LENGTH) {
    const f = LENGTH[w];
    if (PER.has(t[j + 1]) && SECOND.has(t[j + 2])) {
      if (t[j + 3] === 'squared' || t[j + 3] === '2') return { cat: 'accel', factor: f, end: j + 4, word: true };
      return { cat: 'speed', factor: f, end: j + 3, word: true };
    }
    if (PER.has(t[j + 1]) && HOUR.has(t[j + 2])) return { cat: 'speed', factor: f / 3600, end: j + 3, word: true };
    return { cat: 'length', factor: f, end: j + 1, word: w.length > 2 };
  }
  if ((w === 'newton' || w === 'newtons' || w === 'n') && t[j + 1] === 'per' && t[j + 2] in LENGTH)
    return { cat: 'stiffness', factor: 1 / LENGTH[t[j + 2]], end: j + 3, word: true };
  if (w in MASS) return { cat: 'mass', factor: MASS[w], end: j + 1, word: w.length > 2 };
  if (w in SINGLE) return { cat: SINGLE[w][0], factor: SINGLE[w][1], end: j + 1, word: w.length > 3 };
  return null;
}

/** One number heard in a clause, already in the base unit of its category (m, kg, °, m/s, N/m, m/s², ratio). */
interface Quantity {
  value: number;
  cat: Cat | null;
  /** Token index of the number. */
  at: number;
}

function quantities(t: string[]): Quantity[] {
  const out: Quantity[] = [];
  for (let i = 0; i < t.length; i++) {
    let value: number | undefined;
    let next = i + 1;
    if (isDigits(t[i])) value = Number(t[i]);
    else if (t[i] === 'half') {
      // "half a meter", "half a kilo"
      next = t[i + 1] === 'a' || t[i + 1] === 'an' ? i + 2 : i + 1;
      if (readUnit(t, next)) value = 0.5;
    } else if ((t[i] === 'a' || t[i] === 'an') && readUnit(t, i + 1)?.word) {
      value = 1; // "a meter", "a kilogram"
    }
    if (value === undefined) continue;
    const u = readUnit(t, next);
    out.push({ value: u ? value * u.factor : value, cat: u ? u.cat : null, at: i });
    if (u) i = u.end - 1;
  }
  return out;
}

// ---- Text -> tokens ------------------------------------------------------------------------------------

/** Lower case, units like "m/s" and "°" as words, number words as digits. Commas stay as "," tokens. */
export function tokenize(utterance: string): string[] {
  const s = utterance
    .toLowerCase()
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/(\d)([a-z°])/g, '$1 $2')
    .replace(/°/g, ' degrees ')
    .replace(/\bm\/s(²|2|\^2| squared)/g, ' mpss ')
    .replace(/\bcm\/s\b/g, ' cmps ')
    .replace(/\bkm\/h\b|\bkm\/hr\b/g, ' kmh ')
    .replace(/\bm\/s\b/g, ' mps ')
    .replace(/\bn\/m\b/g, ' npm ')
    .replace(/[‘’']/g, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[,;!?]/g, ' , ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/[^a-z0-9., ]/g, ' ');
  const raw = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; ) {
    const r = readNumber(raw, i, out[out.length - 1]);
    if (r) {
      out.push(String(Number(r.value.toPrecision(12))));
      i = r.end;
    } else out.push(raw[i++]);
  }
  return out;
}

const CLAUSE_BREAK = new Set([',', 'and', 'then', 'also', 'plus', 'but']);

// ---- Targets -------------------------------------------------------------------------------------------

const words = (list: string) => new RegExp(`\\b(?:${list.split('|').map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`);
const wordsG = (re: RegExp) => new RegExp(re.source, 'g');

interface TargetDef {
  key: VoiceKey;
  /** Words that name it ("string", "bob", "angle"). */
  kw: RegExp;
  /** Units it accepts (a bare number is always accepted when it is named). */
  cats: Cat[];
  up?: RegExp;
  down?: RegExp;
  /** Its own up/down words only count when it is named too ("left ... heavier"). */
  upNeedsName?: boolean;
  /** One step up (+1) or down (−1) from v. */
  step: (v: number, dir: 1 | -1) => number;
}

const mul = (k: number) => (v: number, dir: 1 | -1) => (dir > 0 ? v * k : v / k);
const SPEED_KW = 'speed|velocity|launch|launches|launched|fire|shoot|throw|initial speed|fast|faster|slower|quicker';
const SPEED_UP = words('faster|quicker|harder|further|farther|more power|speed up|speed it up');
const SPEED_DOWN = words('slower|slow down|slow it down|softer|gentler|less power');
const MASS_UP = words('heavier|heavy|more massive');
const MASS_DOWN = words('lighter|less heavy|less massive');

const DEFS: TargetDef[] = [
  { key: 'gravity', kw: words('gravity|gravitational|g force'), cats: ['accel', 'speed'], step: mul(1.5) },
  {
    key: 'friction',
    kw: words('friction|frictional|grip'),
    cats: ['ratio'],
    step: (v, dir) => (dir > 0 ? Math.max(v * 1.5, v + 0.1) : v / 1.5),
  },
  { key: 'launchSpeed', kw: words(SPEED_KW), cats: ['speed'], up: SPEED_UP, down: SPEED_DOWN, step: mul(1.4) },
  { key: 'speed', kw: words(SPEED_KW), cats: ['speed'], up: SPEED_UP, down: SPEED_DOWN, step: mul(1.4) },
  {
    key: 'stringLength',
    kw: words('string|rope|cord|thread|pendulum|length|long|longer|shorter'),
    cats: ['length'],
    up: words('longer|lengthen'),
    down: words('shorter|shorten'),
    step: mul(1.5),
  },
  { key: 'bobMass', kw: words('bob|ball|weight|mass|heavy|heavier|lighter|object'), cats: ['mass'], up: MASS_UP, down: MASS_DOWN, step: mul(2) },
  {
    key: 'springMass',
    kw: words('mass|block|box|weight|object|load|heavy|heavier|lighter'),
    cats: ['mass'],
    up: MASS_UP,
    down: MASS_DOWN,
    step: mul(2),
  },
  {
    key: 'springK',
    kw: words('spring|spring constant|constant|stiffness|stiff|stiffer|softer|looser|k'),
    cats: ['stiffness'],
    up: words('stiffer|stiff|tighter|stronger spring|harder spring'),
    down: words('softer|looser|weaker spring|bouncier|stretchier'),
    step: mul(2),
  },
  { key: 'blockMass', kw: words('block|box|mass|weight|object|heavy|heavier|lighter'), cats: ['mass'], up: MASS_UP, down: MASS_DOWN, step: mul(2) },
  {
    key: 'rampAngle',
    kw: words('angle|slope|ramp|incline|hill|steep|steeper|flatter|tilt'),
    cats: ['angle'],
    up: words('steeper|steep|steepen'),
    down: words('flatter|flat|flatten|less steep|gentler|shallower'),
    step: (v, dir) => v + 10 * dir,
  },
  {
    key: 'groundLength',
    kw: words('ground|floor|table|distance|field'),
    cats: ['length'],
    up: words('longer|wider|bigger'),
    down: words('shorter|narrower|smaller'),
    upNeedsName: true,
    step: mul(1.5),
  },
  { key: 'leftMass', kw: words('left'), cats: ['mass'], up: MASS_UP, down: MASS_DOWN, upNeedsName: true, step: mul(2) },
  { key: 'rightMass', kw: words('right'), cats: ['mass'], up: MASS_UP, down: MASS_DOWN, upNeedsName: true, step: mul(2) },
];

const G_DOUBLE = words('double|twice');
const G_TRIPLE = words('triple');
const G_HALF = words('half|halve');
const G_UP = words('more|higher|bigger|increase|greater|stronger|up|raise|larger');
const G_DOWN = words('less|lower|smaller|decrease|reduce|weaker|down|fewer');

const CAT_NAME: Record<Cat, string> = {
  length: 'length',
  mass: 'mass',
  angle: 'angle',
  speed: 'speed',
  stiffness: 'spring constant',
  accel: 'gravity',
  ratio: 'value',
  times: 'value',
};

const round3 = (v: number) => Number(v.toPrecision(3));

/**
 * Instant, offline: the settings a spoken sentence changes on the scene on screen.
 * Explicit numbers ("1 meter", "45 degrees") come back as heard, converted to the box's unit; relative words
 * ("heavier", "steeper", "double gravity") are worked out from the current value and kept inside the range.
 */
export function parseVoice(utterance: string, ctx: VoiceContext): VoiceResult {
  const out: VoiceResult = { set: {}, problems: [] };
  const avail = new Map(ctx.targets.map((t) => [t.key, t]));
  // The launch speed box and the launch speed slider are the same thing; the box wins when there is one.
  const defs = DEFS.filter((d) => avail.has(d.key) && !(d.key === 'speed' && avail.has('launchSpeed')));
  const problem = (p: string) => {
    if (!out.problems.includes(p)) out.problems.push(p);
  };

  const tokens = tokenize(utterance);
  const clauses: string[][] = [[]];
  for (const tok of tokens) {
    if (CLAUSE_BREAK.has(tok)) clauses.push([]);
    else clauses[clauses.length - 1].push(tok);
  }

  for (const t of clauses.filter((c) => c.length)) {
    const text = ` ${t.join(' ')} `;
    const has = (re: RegExp) => re.test(text);
    const done = new Set<VoiceKey>();
    const put = (key: VoiceKey, v: number) => {
      if (key in out.set || !Number.isFinite(v)) return;
      out.set[key] = v;
      done.add(key);
    };
    const named = defs.filter((d) => has(d.kw));

    // --- switches ---
    if (has(/\b(air|drag|air resistance|wind resistance)\b/) || has(/\bvacuum\b/)) {
      const off = has(/\b(no|off|without|remove|disable|stop|kill|vacuum|zero|less)\b/);
      const on = has(/\b(on|add|with|enable|use|put|include|some|more|show|give)\b/) || has(/\b(air resistance|drag|wind resistance)\b/);
      if (off || on) {
        if (ctx.air) out.air = !off;
        else problem('This drawing has no air resistance.');
      }
    }
    if (has(/\b(arrows?|vectors?)\b/)) out.arrows = !has(/\b(hide|off|no|remove|without|disable|stop|less)\b/);

    // --- reset ---
    const resetWord = has(/\b(reset|start over|clear|restore|defaults?|original)\b/);
    if (resetWord && !has(/\bgravity\b/)) {
      if (ctx.numbers) out.reset = true;
      if (has(/\b(all|everything)\b/) || !ctx.numbers) put('gravity', PLANETS.earth);
    }

    // --- gravity words ---
    if (avail.has('gravity')) {
      const planet = Object.keys(PLANETS).find((p) => text.includes(` ${p} `) || text.includes(` ${p}s `));
      if (planet === 'moon' && has(/\b(off|exit|leave|stop|no)\b/)) put('gravity', PLANETS.earth);
      else if (has(/\b(no|0|without|turn off|remove)\b[a-z ]{0,12}\bgravity\b|\bspace\b|\bweightless\b|\b0 g\b/)) put('gravity', 0);
      else if (planet && !t.some(isDigits)) put('gravity', PLANETS[planet]);
      else if (has(/\bgravity\b/) && (resetWord || has(/\b(normal|regular|default|usual|real)\b/))) put('gravity', PLANETS.earth);
    }

    // --- friction words ---
    if (avail.has('friction')) {
      const f = avail.get('friction')!;
      if (has(/\b(no|0|without|remove)\b[a-z ]{0,12}\bfriction\b|\bfrictionless\b|\bice\b|\bicy\b/)) put('friction', 0);
      else if (has(/\bslippery\b|\bslippier\b/)) put('friction', f.value / 2);
      else if (has(/\b(sticky|rough|rougher|grippy|sandpaper)\b/)) put('friction', Math.min(f.max, Math.max(0.6, f.value * 2)));
    }

    // --- numbers heard: give each to the setting named nearest to it, or the only one its unit fits ---
    for (const q of quantities(t)) {
      if (q.value === 0 && q.cat === 'mass' && has(/\b0 g\b/)) continue; // "zero g" is gravity, not 0 grams
      if (q.cat === 'times') {
        // "3 times heavier", "gravity 2 times stronger"
        const d = nearest(named.filter((x) => !done.has(x.key)), t, q.at);
        const cur = d && avail.get(d.key)!;
        if (d && cur && Number.isFinite(cur.value) && q.value > 0) {
          const down = (d.down && has(d.down)) || has(G_DOWN);
          put(d.key, clamp(round3(down ? cur.value / q.value : cur.value * q.value), cur.min, cur.max));
        }
        continue;
      }
      let pool = named.filter((d) => !done.has(d.key) && (q.cat === null || d.cats.includes(q.cat)));
      if (!pool.length && q.cat) {
        const byUnit = defs.filter((d) => d.cats[0] === q.cat && !done.has(d.key));
        if (byUnit.length === 1) pool = byUnit;
        else if (byUnit.length > 1 && q.cat === 'mass' && byUnit.every((d) => d.key === 'leftMass' || d.key === 'rightMass')) {
          if (has(/\b(both|each)\b/)) {
            for (const d of byUnit) put(d.key, q.value);
          } else problem('Say which weight: “left 3 kilograms” or “right 1 kilogram”.');
          continue;
        } else if (!byUnit.length && !defs.some((d) => done.has(d.key) && d.cats.includes(q.cat!))) {
          problem(`This drawing has no ${CAT_NAME[q.cat]} to set.`);
          continue;
        }
      }
      const d = nearest(pool, t, q.at);
      if (d) put(d.key, q.value);
    }

    // --- relative words ("heavier", "steeper", "double gravity") for settings without a number ---
    for (const d of defs) {
      if (done.has(d.key) || d.key in out.set) continue;
      const cur = avail.get(d.key)!;
      if (!Number.isFinite(cur.value)) continue;
      const isNamed = named.includes(d);
      let v: number | undefined;
      if (isNamed && has(G_DOUBLE)) v = cur.value * 2;
      else if (isNamed && has(G_TRIPLE)) v = cur.value * 3;
      else if (isNamed && has(G_HALF)) v = cur.value / 2;
      else if ((isNamed || !d.upNeedsName) && d.down && has(d.down)) v = d.step(cur.value, -1);
      else if ((isNamed || !d.upNeedsName) && d.up && has(d.up)) v = d.step(cur.value, 1);
      else if (isNamed && has(G_DOWN)) v = d.step(cur.value, -1);
      else if (isNamed && has(G_UP)) v = d.step(cur.value, 1);
      if (v !== undefined) put(d.key, clamp(round3(v), cur.min, cur.max));
    }
    // "make it heavier" with two weights: which one?
    if (
      avail.has('leftMass') &&
      avail.has('rightMass') &&
      !done.has('leftMass') &&
      !done.has('rightMass') &&
      (has(MASS_UP) || has(MASS_DOWN))
    )
      problem('Say which weight: “make the left weight heavier”.');
  }
  return out;
}

/** The target whose name is said closest to token `at` (before it preferred: "string 1 meter"). */
function nearest(pool: TargetDef[], t: string[], at: number): TargetDef | undefined {
  if (pool.length <= 1) return pool[0];
  const text = t.join(' ');
  let best: TargetDef | undefined;
  let bestD = Infinity;
  for (const d of pool) {
    for (const m of text.matchAll(wordsG(d.kw))) {
      const idx = text.slice(0, m.index).split(' ').length - 1;
      const dist = idx <= at ? at - idx : idx - at + 3;
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
  }
  return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
