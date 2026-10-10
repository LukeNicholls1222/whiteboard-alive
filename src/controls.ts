// Sliders + voice for the running simulation. Gravity is shared by every scene; scene-specific
// sliders come from a table keyed by diagram type (scenes themselves stay untouched).

import { hasApiKey, voiceToParams, type VoiceParamSpec } from './ai';
import { airSubtitle } from './air';
import type { Entries, EntryField, EntryKey } from './entries';
import type { DiagramType, SimParams } from './types';
import {
  PLANETS,
  isEmptyResult,
  listenOnce,
  parseVoice,
  speechSupported,
  type VoiceContext,
  type VoiceKey,
  type VoiceResult,
} from './voice';

export interface ParamSpec extends VoiceParamSpec {
  step: number;
  value: number;
  /** Read only when the scene is built, so changing it rebuilds the scene. */
  rebuild?: boolean;
  /**
   * Applied live, and the scene also replays from the start once the finger settles. For values
   * whose effect is only visible while things move (friction): the block has usually already
   * stopped at the bottom by the time someone reaches the slider.
   */
  replay?: boolean;
  /** Digits shown in the value bubble. */
  digits: number;
}

const GRAVITY: ParamSpec = { key: 'gravity', label: 'Gravity', min: 0, max: 25, step: 0.1, value: 9.8, unit: 'm/s²', digits: 1 };

/**
 * Which extra sliders each diagram gets. Only parameters the scene actually reads. The launch speed is in m/s;
 * its range and starting value come from the drawing (see `tune` in show()), these are only placeholders.
 */
const SCENE_PARAMS: Partial<Record<DiagramType, ParamSpec[]>> = {
  incline: [{ key: 'friction', label: 'Friction', min: 0, max: 1.5, step: 0.05, value: 0.3, digits: 2, replay: true }],
  projectile: [{ key: 'speed', label: 'Launch speed', min: 0.5, max: 10, step: 0.1, value: 3, unit: 'm/s', digits: 1, rebuild: true }],
};

/** Per-drawing slider settings (range, step, starting value), e.g. a launch speed range around the fitted speed. */
export type SliderTune = Partial<Record<string, Partial<Pick<ParamSpec, 'min' | 'max' | 'step' | 'digits' | 'value'>>>>;

/** Launch speed slider for a drawing: 0.2× to 2.5× the speed that lands inside the picture (and the written one). */
export function launchSpeedTune(fit: number, value: number): SliderTune {
  const lo = Math.min(fit, value) * 0.2;
  const hi = Math.max(fit, value) * 2.5;
  const step = 10 ** Math.floor(Math.log10(hi / 50));
  const digits = Math.max(0, -Math.round(Math.log10(step)));
  const min = Math.max(step, Math.floor(lo / step) * step);
  const max = Math.ceil(hi / step) * step;
  return { speed: { min: +min.toFixed(digits), max: +max.toFixed(digits), step, digits, value: +value.toFixed(digits + 1) } };
}

/** Pause after the last friction tick before the slide replays (long enough to see the live change). */
const REPLAY_MS = 400;

const PRESETS:{ name: string; g: number }[] = [
  { name: 'Earth', g: PLANETS.earth },
  { name: 'Moon', g: PLANETS.moon },
  { name: 'Jupiter', g: PLANETS.jupiter },
];

export interface ControlsHost {
  /** Apply a parameter diff. `rebuild` = a build-time parameter changed, rebuild the scene. */
  apply(set: Partial<SimParams>, rebuild: boolean): void;
  /** "Your numbers" changed (all current entries; `reset` = the Reset button): rebuild the scene with them. */
  enter(entries: Entries, reset: boolean): void;
  /** Voice: turn the velocity arrows on or off. */
  showArrows?(on: boolean): void;
}

/** What a spoken (or typed) command did, for the toast and the tests. */
export interface VoiceOutcome {
  /** "String length 1.00 m", "Air resistance on". */
  changes: string[];
  /** Why something heard was not done ("Angle 80°: use 5 to 75°"). */
  problems: string[];
  /** 'keywords' = understood instantly offline; 'ai' = Gemini was asked because the keywords found nothing. */
  via: 'keywords' | 'ai';
  /** The one line shown under the controls. */
  message: string;
}

/** A sentence to suggest for each number box (the first box on screen gives the hint). */
const SAY_EXAMPLE: Record<EntryKey, string> = {
  stringLength: 'make the string 1 meter',
  bobMass: 'bob mass 2 kilograms',
  springMass: 'mass 2 kilograms',
  springK: 'spring constant 50',
  blockMass: 'block mass 3 kilograms',
  rampAngle: 'angle 45 degrees',
  launchSpeed: 'launch at 10 meters per second',
  groundLength: 'ground 5 meters',
  leftMass: 'left weight 3 kilograms',
  rightMass: 'right weight 1 kilogram',
};

/** Pause after the last keystroke before an entered number is applied. */
const ENTRY_MS = 900;

export const specsFor = (diagram: DiagramType): ParamSpec[] => [GRAVITY, ...(SCENE_PARAMS[diagram] ?? [])];

const fmt = (s: ParamSpec, v: number) => `${v.toFixed(s.digits)}${s.unit ? ` ${s.unit}` : ''}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createControls(root: HTMLElement, host: ControlsHost) {
  let specs: ParamSpec[] = [];
  const values: Record<string, number> = {};
  let rebuildTimer = 0;

  root.innerHTML = `
    <div class="controls-head">
      <h2>Play with it</h2>
      <button type="button" class="mic" id="mic" aria-label="Tap and say a change">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>
        <span class="mic-label">Talk</span>
      </button>
    </div>
    <p class="voice-hint" id="voice-hint">Tap Talk and say “make it the moon”.</p>
    <section class="numbers" id="numbers" hidden aria-labelledby="numbers-title">
      <div class="numbers-head">
        <h3 id="numbers-title">Your numbers</h3>
        <button type="button" class="numbers-reset" id="numbers-reset">Reset</button>
      </div>
      <div class="num-grid" id="num-grid"></div>
    </section>
    <div class="sliders" id="sliders"></div>
    <div id="air-row" hidden>
      <label class="va-toggle">
        <span class="va-text">Air resistance<span class="va-sub" id="air-sub"></span></span>
        <input type="checkbox" id="air" />
        <span class="va-switch"></span>
      </label>
    </div>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>`;
  const sliders = root.querySelector<HTMLDivElement>('#sliders')!;
  const mic = root.querySelector<HTMLButtonElement>('#mic')!;
  const hint = root.querySelector<HTMLParagraphElement>('#voice-hint')!;
  const toast = root.querySelector<HTMLDivElement>('#toast')!;
  const airRow = root.querySelector<HTMLDivElement>('#air-row')!;
  const airInput = root.querySelector<HTMLInputElement>('#air')!;
  const airSub = root.querySelector<HTMLSpanElement>('#air-sub')!;
  const numbersEl = root.querySelector<HTMLElement>('#numbers')!;
  const numGrid = root.querySelector<HTMLDivElement>('#num-grid')!;
  const numReset = root.querySelector<HTMLButtonElement>('#numbers-reset')!;
  /** Factor on real air this scene uses when the switch is on (0 = the scene has no air drag, switch hidden). */
  let airFactor = 0;
  // Live like the sliders: the scenes read params.airDrag every step, so nothing is rebuilt.
  airInput.addEventListener('change', () => {
    haptic();
    host.apply({ airDrag: airInput.checked ? airFactor : 0 }, false);
  });
  if (!speechSupported()) {
    mic.hidden = true;
    hint.hidden = true;
  }

  function render() {
    sliders.innerHTML = specs
      .map(
        (s) => `
      <div class="param" data-key="${s.key}">
        <div class="param-row">
          <label for="p-${s.key}">${s.label}</label>
          <span class="param-value" id="v-${s.key}">${fmt(s, values[s.key])}</span>
        </div>
        <input type="range" id="p-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${values[s.key]}" />
        ${s.key === 'gravity' ? `<div class="chips">${PRESETS.map((p) => `<button type="button" class="chip" data-g="${p.g}">${p.name}</button>`).join('')}</div>` : ''}
      </div>`,
      )
      .join('');
    for (const s of specs) {
      const input = sliders.querySelector<HTMLInputElement>(`#p-${s.key}`)!;
      input.addEventListener('input', () => set({ [s.key]: Number(input.value) }, 'slider'));
    }
    sliders.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        haptic();
        set({ gravity: Number(chip.dataset.g) }, 'chip');
        say(`Gravity → ${fmt(GRAVITY, Number(chip.dataset.g))}`);
      }),
    );
    syncUI();
  }

  function syncUI() {
    for (const s of specs) {
      const input = sliders.querySelector<HTMLInputElement>(`#p-${s.key}`);
      const label = sliders.querySelector<HTMLSpanElement>(`#v-${s.key}`);
      if (input && Number(input.value) !== values[s.key]) input.value = String(values[s.key]);
      if (label) label.textContent = fmt(s, values[s.key]);
      if (input) input.style.setProperty('--fill', `${((values[s.key] - s.min) / (s.max - s.min)) * 100}%`);
    }
    sliders.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) =>
      chip.classList.toggle('on', Math.abs(Number(chip.dataset.g) - values.gravity) < 0.05),
    );
  }

  /** Clamp, store, update the UI and hand the diff to the simulation. Returns what actually changed. */
  function set(diff: Record<string, number>, _from: 'slider' | 'chip' | 'voice'): Record<string, number> {
    const changed: Record<string, number> = {};
    let rebuild = false;
    let replay = false;
    for (const s of specs) {
      if (!(s.key in diff) || !Number.isFinite(diff[s.key])) continue;
      const v = Number(clamp(diff[s.key], s.min, s.max).toFixed(s.digits + 1));
      if (v === values[s.key]) continue;
      values[s.key] = v;
      changed[s.key] = v;
      if (s.rebuild) rebuild = true;
      if (s.replay) replay = true;
    }
    if (!Object.keys(changed).length) return changed;
    syncUI();
    mirrorSpeed(changed);
    const live = Object.fromEntries(Object.entries(changed).filter(([k]) => !specs.find((s) => s.key === k)?.rebuild));
    if (Object.keys(live).length) host.apply(live as Partial<SimParams>, false);
    if (rebuild) {
      // Rebuilding redoes the scene geometry; wait for the finger to settle instead of rebuilding every tick.
      clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => host.apply({ ...values } as Partial<SimParams>, true), 180);
    } else if (replay) {
      // Already applied live above; replay from the start so the new value is seen from a fresh slide.
      clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => host.apply({ ...values } as Partial<SimParams>, true), REPLAY_MS);
    }
    return changed;
  }

  /** Mirror a change made elsewhere (e.g. the Moon switch) without sending it back to the sim. */
  function sync(p: Partial<SimParams>) {
    let any = false;
    for (const s of specs) {
      const v = p[s.key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v === values[s.key]) continue;
      values[s.key] = v;
      any = true;
    }
    if (any) syncUI();
  }

  /** The launch speed box follows its slider (and the slider follows the box, through the rebuilt scene). */
  function mirrorSpeed(changed: Record<string, number>) {
    const f = fields.find((x) => x.key === 'launchSpeed');
    if (!f || !('speed' in changed)) return;
    f.mirror = changed.speed;
    const input = box('launchSpeed');
    if (!input || document.activeElement === input) return;
    input.value = num(changed.speed);
    shown.launchSpeed = input.value;
    clearError('launchSpeed');
  }

  // ---- Your numbers ----------------------------------------------------------------------------------
  let fields: EntryField[] = [];
  let entries: Entries = {};
  /** Text each box showed when it was last applied or rendered: an unchanged box is never applied again. */
  const shown: Partial<Record<EntryKey, string>> = {};
  const entryTimers: Partial<Record<EntryKey, number>> = {};
  const box = (key: EntryKey) => numGrid.querySelector<HTMLInputElement>(`#n-${key}`);
  const num = (v: number) => String(Number(v.toPrecision(4)));

  function renderNumbers() {
    numbersEl.hidden = !fields.length;
    numGrid.innerHTML = fields
      .map(
        (f) => `
      <div class="num" data-key="${f.key}">
        <label for="n-${f.key}">${f.label}</label>
        <div class="num-box">
          <input id="n-${f.key}" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" autocorrect="off"
            autocapitalize="off" spellcheck="false" aria-describedby="m-${f.key}" />
          <span class="num-unit">${f.unit}</span>
        </div>
        <p class="num-msg" id="m-${f.key}" aria-live="polite"></p>
      </div>`,
      )
      .join('');
    for (const f of fields) {
      const input = box(f.key)!;
      const v = entries[f.key] ?? f.mirror;
      input.value = v === undefined ? '' : num(v);
      shown[f.key] = input.value;
      input.addEventListener('input', () => {
        clearError(f.key);
        clearTimeout(entryTimers[f.key]);
        entryTimers[f.key] = window.setTimeout(() => commit(f.key), ENTRY_MS);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        commit(f.key);
        input.blur(); // closes the phone keyboard
      });
      input.addEventListener('blur', () => commit(f.key));
    }
    syncNumbers();
  }

  /** Placeholders / limits / mirrored values of the boxes already on screen (keeps focus, text and errors). */
  function syncNumbers() {
    for (const f of fields) {
      const input = box(f.key);
      if (!input) continue;
      input.placeholder = f.placeholder;
      if (entries[f.key] === undefined && f.mirror !== undefined && document.activeElement !== input) {
        input.value = num(f.mirror);
        shown[f.key] = input.value;
      }
    }
    numReset.disabled = !Object.keys(entries).length && !fields.some((f) => f.mirror !== undefined);
  }

  function setError(key: EntryKey, text: string) {
    numGrid.querySelector(`.num[data-key="${key}"]`)?.classList.add('bad');
    box(key)?.setAttribute('aria-invalid', 'true');
    const m = numGrid.querySelector<HTMLParagraphElement>(`#m-${key}`);
    if (m) m.textContent = text;
  }
  function clearError(key: EntryKey) {
    numGrid.querySelector(`.num[data-key="${key}"]`)?.classList.remove('bad');
    box(key)?.removeAttribute('aria-invalid');
    const m = numGrid.querySelector<HTMLParagraphElement>(`#m-${key}`);
    if (m) m.textContent = '';
  }

  /** Read one box: empty = back to assumed, a number in range = applied, anything else = red border, not applied. */
  function commit(key: EntryKey) {
    clearTimeout(entryTimers[key]);
    const f = fields.find((x) => x.key === key);
    const input = box(key);
    if (!f || !input) return;
    const text = input.value.trim().replace(',', '.');
    if (text === (shown[key] ?? '')) return;
    if (text === '') {
      shown[key] = '';
      clearError(key);
      if (entries[key] === undefined) return;
      delete entries[key];
      host.enter({ ...entries }, false);
      return;
    }
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return setError(key, `Type a number, ${rangeText(f)}`);
    const c = checkEntry(f, Number(text));
    if (!c.ok) return setError(key, c.msg);
    // A ramp stretched that steep would leave the picture: take the steepest that fits, and say so.
    if (c.lowered) input.value = num(c.v);
    shown[key] = input.value;
    if (c.lowered) setError(key, `${num(c.v)}° is the most that fits this drawing`);
    else clearError(key);
    if (entries[key] === c.v) return;
    entries[key] = c.v;
    haptic();
    host.enter({ ...entries }, false);
  }

  const rangeText = (f: EntryField) => `${num(f.min)} to ${num(f.fitMax ?? f.max)}${f.unit === '°' ? '°' : ` ${f.unit}`}`;

  /** The range rule for a number box, shared by typing and voice: refused (with the box's message) or accepted. */
  function checkEntry(f: EntryField, v: number): { ok: false; msg: string } | { ok: true; v: number; lowered: boolean } {
    if (!Number.isFinite(v)) return { ok: false, msg: `Type a number, ${rangeText(f)}` };
    if (v < f.min || v > f.max) return { ok: false, msg: `Use ${rangeText(f)}` };
    if (f.fitMax !== undefined && v > f.fitMax) return { ok: true, v: f.fitMax, lowered: true };
    return { ok: true, v, lowered: false };
  }

  /** Empty every box (without rebuilding: the caller sends host.enter). */
  function clearNumbers() {
    for (const f of fields) {
      clearTimeout(entryTimers[f.key]);
      clearError(f.key);
      const input = box(f.key);
      if (input) input.value = '';
      shown[f.key] = '';
    }
    entries = {};
  }

  numReset.addEventListener('click', () => {
    haptic();
    clearNumbers();
    host.enter({}, true);
  });

  let toastTimer = 0;
  function say(text: string, kind: 'ok' | 'info' | 'warn' = 'ok', ms = 4000) {
    toast.textContent = text;
    toast.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms);
  }

  // ---- Voice ----------------------------------------------------------------------------------------------
  let diagramShown: DiagramType = 'fallback';

  /** The sentence to suggest for the scene on screen. */
  const example = () => (fields.length ? SAY_EXAMPLE[fields[0].key] : diagramShown === 'incline' ? 'no friction' : 'make it the moon');
  const updateHint = () => (hint.textContent = `Tap Talk and say “${example()}” or “moon”.`);

  /** Value as shown for a number box: "1.00 m", "45°", "2.00 kg". */
  const fmtEntry = (f: EntryField, v: number) =>
    f.unit === '°' ? `${num(v)}°` : `${Math.abs(v) >= 100 ? num(v) : v.toPrecision(3)} ${f.unit}`;

  /** Settings the scene on screen offers, with their current values: sliders, number boxes, switches. */
  function voiceContext(): VoiceContext {
    return {
      targets: [
        ...specs.map((s) => ({ key: s.key as VoiceKey, value: values[s.key], min: s.min, max: s.max })),
        ...fields.map((f) => ({
          key: f.key,
          // An empty box: the value the scene assumed / measured, from its placeholder ("0.43 assumed", "31° drawn").
          value: entries[f.key] ?? f.mirror ?? parseFloat(f.placeholder),
          min: f.min,
          max: f.fitMax ?? f.max,
        })),
      ],
      air: airFactor > 0 && !airRow.hidden,
      numbers: fields.length > 0,
    };
  }

  /** The same settings for Gemini (keys, labels, units, ranges); the launch speed slider is its box when there is one. */
  function aiSpecs(ctx: VoiceContext): VoiceParamSpec[] {
    const hasBox = fields.some((f) => f.key === 'launchSpeed');
    const out: VoiceParamSpec[] = [
      ...specs.filter((s) => !(s.key === 'speed' && hasBox)).map(({ key, label, min, max, unit }) => ({ key, label, min, max, unit })),
      ...fields.map((f) => ({ key: f.key, label: f.label, min: f.min, max: f.fitMax ?? f.max, unit: f.unit })),
      { key: 'arrows', label: 'Velocity arrows switch', min: 0, max: 1 },
    ];
    if (ctx.air) out.push({ key: 'air', label: 'Air resistance switch', min: 0, max: 1 });
    if (ctx.numbers) out.push({ key: 'reset', label: 'Clear every typed number (1 = clear)', min: 0, max: 1 });
    return out;
  }

  /** Gemini's {"set": {...}} as a parser result. */
  function fromAI(set: Record<string, number>): VoiceResult {
    const r: VoiceResult = { set: {}, problems: [] };
    for (const [k, v] of Object.entries(set)) {
      if (k === 'air') r.air = v >= 0.5;
      else if (k === 'arrows') r.arrows = v >= 0.5;
      else if (k === 'reset') r.reset = v >= 0.5 || undefined;
      else r.set[k as VoiceKey] = v;
    }
    return r;
  }

  /**
   * Apply what was heard exactly like the controls would: sliders through set(), numbers through the boxes'
   * range rule and host.enter (as if typed), switches as if flipped. Out-of-range values are refused with a reason.
   */
  function applyVoice(utterance: string, r: VoiceResult, via: VoiceOutcome['via']): VoiceOutcome {
    const changes: string[] = [];
    const problems = [...r.problems];
    let rebuild = false;
    let reset = false;
    if (r.reset && fields.length) {
      clearNumbers();
      changes.push('Your numbers cleared');
      rebuild = reset = true;
    }
    for (const [k, v] of Object.entries(r.set) as [VoiceKey, number][]) {
      const f = fields.find((x) => x.key === k);
      const input = f && box(f.key);
      if (!f || !input) continue;
      const c = checkEntry(f, v);
      if (!c.ok) {
        setError(f.key, c.msg);
        problems.push(`${f.label} ${fmtEntry(f, v)} is out of range: ${c.msg.replace(/^Use /, 'use ')}.`);
        continue;
      }
      // Into the box as if typed: same text, same refusal / lowering, same rebuild.
      clearTimeout(entryTimers[f.key]);
      input.value = num(c.v);
      shown[f.key] = input.value;
      if (c.lowered) {
        setError(f.key, `${num(c.v)}° is the most that fits this drawing`);
        problems.push(`${num(c.v)}° is the most that fits this drawing.`);
      } else clearError(f.key);
      changes.push(`${f.label} ${fmtEntry(f, c.v)}`);
      if (entries[f.key] !== c.v) {
        entries[f.key] = c.v;
        rebuild = true;
      }
    }
    // Numbers first: the rebuild must not undo a gravity change made in the same sentence (Moon mode re-applies
    // its gravity to a new scene until its switch has seen the change). Sliders and switches then go to the new scene.
    if (rebuild) host.enter({ ...entries }, reset);
    const diff: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.set) as [VoiceKey, number][]) {
      const s = specs.find((x) => x.key === k);
      if (!s) continue;
      if (!(v >= s.min && v <= s.max)) {
        problems.push(`${s.label} ${fmt(s, v)} is out of range: use ${fmt(s, s.min)} to ${fmt(s, s.max)}.`);
        continue;
      }
      diff[k] = v;
      const planet = k === 'gravity' ? Object.keys(PLANETS).find((p) => Math.abs(PLANETS[p] - v) < 0.005) : undefined;
      changes.push(`${s.label} ${fmt(s, Number(v.toFixed(s.digits + 1)))}${planet ? ` (${planet[0].toUpperCase()}${planet.slice(1)})` : ''}`);
    }
    set(diff, 'voice');
    if (r.air !== undefined) {
      if (airFactor > 0 && !airRow.hidden) {
        if (airInput.checked !== r.air) {
          airInput.checked = r.air;
          host.apply({ airDrag: r.air ? airFactor : 0 }, false);
        }
        changes.push(`Air resistance ${r.air ? 'on' : 'off'}`);
      } else if (!problems.includes('This drawing has no air resistance.')) problems.push('This drawing has no air resistance.');
    }
    if (r.arrows !== undefined && host.showArrows) {
      host.showArrows(r.arrows);
      changes.push(`Velocity arrows ${r.arrows ? 'on' : 'off'}`);
    }
    if (changes.length || problems.length) haptic();

    const heard = `“${utterance}”`;
    let message: string;
    if (changes.length) message = `${heard} → ${changes.join(', ')}${problems.length ? `. ${problems.join(' ')}` : ''}`;
    else if (problems.length) message = `${heard} — ${problems.join(' ')}`;
    else message = `${heard} — I didn't catch a setting. Try “${example()}”.`;
    say(message, changes.length ? 'ok' : 'warn', 6000);
    return { changes, problems, via, message };
  }

  /**
   * Voice / typed command. The instant keyword parser first (offline, free); only when it understands nothing at
   * all is Gemini asked (≤ 6 s, skipping models out of quota).
   */
  async function command(utterance: string): Promise<VoiceOutcome> {
    const ctx = voiceContext();
    let r = parseVoice(utterance, ctx);
    let via: VoiceOutcome['via'] = 'keywords';
    if (isEmptyResult(r) && hasApiKey()) {
      say(`“${utterance}” — thinking…`, 'info', 7000);
      const current = Object.fromEntries(ctx.targets.filter((t) => Number.isFinite(t.value)).map((t) => [t.key, t.value]));
      try {
        r = fromAI(await voiceToParams(utterance, current, aiSpecs(ctx)));
        via = 'ai';
      } catch (err) {
        console.info('[voice] AI unavailable', err);
      }
    }
    return applyVoice(utterance, r, via);
  }

  let listening: { stop: () => void } | null = null;
  mic.addEventListener('click', async () => {
    haptic();
    if (listening) {
      listening.stop();
      return;
    }
    mic.classList.add('listening');
    mic.querySelector('.mic-label')!.textContent = 'Listening';
    say('Listening…', 'info');
    try {
      const l = listenOnce((t) => say(t ? `“${t}”` : 'Listening…', 'info'));
      listening = l;
      const text = await l.result;
      listening = null;
      mic.querySelector('.mic-label')!.textContent = 'Thinking';
      await command(text);
    } catch (err: any) {
      const code = err?.message;
      say(
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Please allow the microphone to talk to it.'
          : 'I did not catch that. Tap Talk and try again!',
        'warn',
      );
    } finally {
      listening = null;
      mic.classList.remove('listening');
      mic.querySelector('.mic-label')!.textContent = 'Talk';
    }
  });

  return {
    /**
     * Show the controls for a freshly built scene. Keeps values the user already chose, except where the drawing
     * sets its own slider (`tune`, e.g. a launch speed in this drawing's m/s).
     */
    show(diagram: DiagramType, params: Partial<SimParams>, tune: SliderTune = {}, air?: number) {
      diagramShown = diagram;
      specs = specsFor(diagram).map((s) => (tune[s.key] ? { ...s, ...tune[s.key] } : s));
      for (const s of specs) {
        const own = tune[s.key]?.value;
        values[s.key] = Number.isFinite(params[s.key]) ? (params[s.key] as number) : own ?? values[s.key] ?? s.value;
      }
      render();
      // Air resistance switch only where the scene reads it (`air` = its factor on real air), off by default.
      airFactor = air && air > 0 ? air : 0;
      airRow.hidden = !airFactor;
      airInput.checked = !!airFactor && (params.airDrag ?? 0) > 0;
      airSub.textContent = airFactor ? airSubtitle(airFactor) : '';
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
    /**
     * "Your numbers" for the scene on screen. `fresh` = a new photo: every box starts empty. Otherwise boxes that are
     * already there keep their text, focus and errors and only get new placeholders.
     */
    numbers(next: EntryField[], current: Entries, fresh = false) {
      const same = !fresh && next.length === fields.length && next.every((f, i) => f.key === fields[i].key);
      fields = next;
      entries = { ...current };
      if (same) syncNumbers();
      else {
        for (const k of Object.keys(shown) as EntryKey[]) delete shown[k];
        renderNumbers();
      }
      updateHint();
    },
    /** Current values (for tests / debugging). */
    values: () => ({ ...values }),
    entries: () => ({ ...entries }),
    set: (diff: Record<string, number>) => set(diff, 'slider'),
    sync,
    command,
  };
}

function haptic() {
  navigator.vibrate?.(10);
}
