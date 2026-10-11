// The numbers of the drawing, right under the moving picture: one pill per "Your numbers" box ("Length 0.42 m",
// "Mass 1 kg"). Tapping a pill opens a row with − / + buttons, a slider and a small number box, so a length or a
// mass can be changed while the motion stays in sight (no scrolling down to the boxes under the controls).
//
// Generic over fieldsFor() (entries.ts): whatever boxes a scene has show up here too. Values go through the same
// path as typing into a box (controls.ts enterValue -> host.enter -> rebuilt scene); nothing is applied here.
// A slider of the controls can show here too (the ramp's Friction): controls.ts passes it as a field with its own
// fixed `step` and routes its value to the slider instead of a box.

import type { EntryField, EntryKey } from './entries';
import { holdPictureHeight } from './hold';
import type { Quantity } from './types';

/** A box of "Your numbers", or a slider of the controls shown as a pill ('friction'). */
export type QuickKey = EntryKey | 'friction';

/** What a pill needs to know about its value. Every EntryField is one. */
export interface QuickField extends Pick<EntryField, 'label' | 'unit' | 'min' | 'max' | 'fitMax' | 'fitMin'> {
  key: QuickKey;
  quantity: Quantity;
  /** A slider's own fixed step (linear scale, − / + by this much). */
  step?: number;
  /** Digits after the point, as the slider shows them ("0.30"). */
  digits?: number;
}

// ---- Pure helpers (tested in tests/quick.test.ts) -----------------------------------------------------------

/** Shorter names for the pills where the last word of the label would be unclear. */
const SHORT: Partial<Record<QuickKey, string>> = { springK: 'Spring', groundLength: 'Ground' };

/** Pill name: "Left" / "Right" for a side, else the last word of the label ("String length" -> "Length"). */
export function shortLabel(f: Pick<QuickField, 'key' | 'label'>): string {
  const own = SHORT[f.key];
  if (own) return own;
  const words = f.label.trim().split(/\s+/);
  if (/^(left|right)$/i.test(words[0]) && words.length > 1) return cap(words[0]);
  return cap(words[words.length - 1] ?? f.label);
}
const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);

/** Largest value the field takes on this drawing. */
export const highOf = (f: Pick<QuickField, 'max' | 'fitMax'>) => f.fitMax ?? f.max;
/** Smallest value the field takes on this drawing. */
export const lowOf = (f: Pick<QuickField, 'min' | 'fitMin'>) => f.fitMin ?? f.min;

/**
 * Slider position (0..1) <-> value. Angles and narrow ranges are linear; wide positive ranges (0.001 to 1000 kg)
 * are logarithmic so everyday values get room; signed ranges (−100 to 100 m/s) use asinh, linear near 0.
 */
export function sliderScale(f: Pick<QuickField, 'min' | 'max' | 'fitMax' | 'fitMin' | 'quantity' | 'step'>) {
  const lo = lowOf(f), hi = highOf(f);
  type Map = (x: number) => number;
  let to: Map, from: Map;
  if (f.step || f.quantity === 'angle' || (lo > 0 && hi / lo < 20) || hi <= lo) {
    to = (v) => v;
    from = (u) => u;
  } else if (lo > 0) {
    to = Math.log;
    from = Math.exp;
  } else {
    const c = 0.5;
    to = (v) => Math.asinh(v / c);
    from = (u) => c * Math.sinh(u);
  }
  const a = to(lo), b = to(hi);
  return {
    toPos: (v: number) => (b === a ? 0 : Math.min(1, Math.max(0, (to(Math.min(hi, Math.max(lo, v))) - a) / (b - a)))),
    fromPos: (p: number) => Math.min(hi, Math.max(lo, from(a + Math.min(1, Math.max(0, p)) * (b - a)))),
  };
}

/**
 * Step of the − / + buttons at a value: 1° for angles, else half a tenth of the value's decade (0.42 m -> 0.05 m,
 * 2 kg -> 0.5 kg, 3 m/s -> 0.5 m/s, 20 N/m -> 5 N/m; speeds at least 0.1 m/s). Going toward zero uses the smaller
 * decade below (1 -> 0.95).
 */
export function stepAt(f: Pick<QuickField, 'quantity' | 'step'>, v: number, dir: 1 | -1): number {
  if (f.step) return f.step;
  if (f.quantity === 'angle') return 1;
  const toward0 = v !== 0 && Math.sign(dir) !== Math.sign(v);
  const a = Math.abs(v) * (toward0 ? 1 - 1e-9 : 1);
  // Speeds never step finer than 0.1 m/s (a ball at 0.93 m/s goes to 1.0, not 0.95).
  const least = f.quantity === 'speed' ? 0.1 : 0;
  if (!(a > 0)) return least || 0.05;
  return Math.max(least, 5 * 10 ** (Math.floor(Math.log10(a)) - 1));
}

/** Round to a multiple of `step` without float dust. */
export const snap = (v: number, step: number) => Number((Math.round(v / step) * step).toPrecision(12));

/** One − / + press: the next value on the step grid in that direction (0.429 -> 0.45), kept in the field's range. */
export function nudge(f: Pick<QuickField, 'quantity' | 'min' | 'max' | 'fitMax' | 'fitMin' | 'step'>, v: number, dir: 1 | -1): number {
  const step = stepAt(f, v, dir);
  const q = v / step;
  const n = dir > 0 ? Math.floor(q + 1e-6) + 1 : Math.ceil(q - 1e-6) - 1;
  return Math.min(highOf(f), Math.max(lowOf(f), snap(n * step, step)));
}

/** A slider value rounded to what the buttons would step to there (two meaningful digits; whole degrees). */
export function niceSliderValue(f: Pick<QuickField, 'quantity' | 'min' | 'max' | 'fitMax' | 'fitMin' | 'step'>, v: number): number {
  const step = f.step ? f.step : f.quantity === 'angle' ? 1 : Math.abs(v) < 0.05 && f.quantity === 'speed' ? 0.5 : stepAt(f, v, 1) / 5;
  return Math.min(highOf(f), Math.max(lowOf(f), snap(v, step)));
}

/** Number as shown on a pill: up to 3 significant digits, or a slider's own digits ("0.30"). */
export const showNum = (v: number, digits?: number) => (digits !== undefined ? v.toFixed(digits) : String(Number(v.toPrecision(3))));
/** "0.42 m", "31°", "1 kg", "0.30" (no unit). */
export const showValue = (f: Pick<QuickField, 'unit' | 'digits'>, v: number) => {
  const n = showNum(v, f.digits);
  return f.unit === '°' ? `${n}°` : f.unit ? `${n} ${f.unit}` : n;
};

// ---- The strip ----------------------------------------------------------------------------------------------

export interface QuickHost {
  /** Apply a value exactly like a typed box would. Returns a message when refused (out of range). */
  enter(key: QuickKey, value: number): string | null;
}

/** While dragging, at most one rebuild per this many ms (and one more when the finger lets go). */
const DRAG_MS = 150;
/** After touching the strip, how long it is held in place on screen when the picture above changes height. */
const ANCHOR_MS = 1500;

export class QuickNumbers {
  private root: HTMLDivElement;
  private pills: HTMLDivElement;
  private edit: HTMLDivElement;
  private label: HTMLSpanElement;
  private input: HTMLInputElement;
  private unit: HTMLSpanElement;
  private range: HTMLInputElement;
  private fields: QuickField[] = [];
  private values: Partial<Record<QuickKey, number>> = {};
  private entered = new Set<QuickKey>();
  private open: QuickKey | null = null;
  private dragging = false;
  private lastSent = 0;
  private trail = 0;
  private hold = 0;
  /** Where the strip was on screen when last touched, kept there while the picture above resizes. */
  private anchor: { top: number; until: number } | null = null;
  /** Control under the finger: a click that lands elsewhere right after (the page moved) is dropped. */
  private guard: { el: Element; until: number } | null = null;

  private host: QuickHost;

  constructor(card: HTMLElement, host: QuickHost) {
    this.host = host;
    injectStyle();
    this.root = document.createElement('div');
    this.root.className = 'quick';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="quick-pills" role="group" aria-label="Change the numbers"></div>
      <div class="quick-edit" hidden>
        <button type="button" class="quick-step" data-dir="-1" aria-label="Less">&minus;</button>
        <div class="quick-mid">
          <div class="quick-row">
            <span class="quick-label"></span>
            <span class="quick-num">
              <input class="quick-input" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off"
                autocorrect="off" autocapitalize="off" spellcheck="false" />
              <span class="quick-unit"></span>
            </span>
          </div>
          <input class="quick-range" type="range" min="0" max="1000" step="1" />
        </div>
        <button type="button" class="quick-step" data-dir="1" aria-label="More">+</button>
      </div>`;
    card.appendChild(this.root);
    this.pills = this.root.querySelector('.quick-pills')!;
    this.edit = this.root.querySelector('.quick-edit')!;
    this.label = this.root.querySelector('.quick-label')!;
    this.input = this.root.querySelector('.quick-input')!;
    this.unit = this.root.querySelector('.quick-unit')!;
    this.range = this.root.querySelector('.quick-range')!;

    // A new value rebuilds the scene and the picture may change height (a faster launch zooms out): the strip and
    // the button under the finger would jump. While the strip is in use the page scrolls by the same amount instead.
    const stage = card.querySelector('canvas');
    if (stage && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.keepInPlace()).observe(stage);
    this.root.addEventListener('pointerdown', (e) => {
      this.pin();
      const el = (e.target as HTMLElement).closest('button, input');
      this.guard = el ? { el, until: Infinity } : null;
    });
    const release = () => this.guard && (this.guard.until = performance.now() + 700);
    this.root.addEventListener('pointerup', release);
    this.root.addEventListener('pointercancel', release);
    // If the page still moved, the click the browser sends after the finger lifts may land on something else
    // (the Moon switch under the picture): that click is dropped.
    window.addEventListener(
      'click',
      (e) => {
        const g = this.guard;
        if (!g) return;
        this.guard = null;
        if (performance.now() > g.until || g.el.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );

    this.pills.addEventListener('click', (e) => {
      const pill = (e.target as HTMLElement).closest<HTMLButtonElement>('.quick-pill');
      if (!pill) return;
      haptic();
      const key = pill.dataset.key as QuickKey;
      this.setOpen(this.open === key ? null : key);
    });

    // − / +: one step per tap; holding repeats (rebuilds are thinned out like a drag).
    for (const btn of this.edit.querySelectorAll<HTMLButtonElement>('.quick-step')) {
      const dir = Number(btn.dataset.dir) as 1 | -1;
      const stop = () => {
        clearTimeout(this.hold);
        this.hold = 0;
      };
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        stop();
        this.step(dir);
        const again = (ms: number) => (this.hold = window.setTimeout(() => (this.step(dir), again(110)), ms));
        again(450);
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, () => (stop(), this.flush()));
      // Keyboard (Enter / Space) gives a click with no pointerdown.
      btn.addEventListener('click', (e) => {
        if (e.detail === 0) this.step(dir), this.flush();
      });
    }

    this.range.addEventListener('pointerdown', () => (this.dragging = true));
    this.range.addEventListener('input', () => {
      const f = this.field();
      if (!f) return;
      this.dragging = true;
      this.show(f, niceSliderValue(f, sliderScale(f).fromPos(Number(this.range.value) / 1000)), false);
    });
    this.range.addEventListener('change', () => {
      this.dragging = false;
      this.flush();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.typed();
      this.input.blur();
    });
    this.input.addEventListener('blur', () => this.typed());
    this.input.addEventListener('input', () => this.input.classList.remove('bad'));
  }

  /** The boxes of the scene on screen and their current values (entered, mirrored or the scene's own). */
  render(fields: QuickField[], values: Partial<Record<QuickKey, number>>, entered: Set<QuickKey>, fresh: boolean) {
    const same = !fresh && fields.length === this.fields.length && fields.every((f, i) => f.key === this.fields[i].key);
    this.fields = fields;
    this.entered = entered;
    if (!same) {
      this.pills.innerHTML = fields
        .map(
          (f) => `<button type="button" class="quick-pill" data-key="${f.key}" aria-expanded="false" title="${f.label}">
            <span class="qp-name">${shortLabel(f)}</span><span class="qp-val"></span></button>`,
        )
        .join('');
      if (!fields.some((f) => f.key === this.open)) this.open = null;
      if (fresh) this.open = null;
    }
    // A value being dragged or stepped stays as the finger has it until it is sent.
    for (const f of fields) if (!(this.pending && this.open === f.key)) this.values[f.key] = values[f.key];
    this.root.hidden = !fields.length;
    this.setOpen(this.open, false);
  }

  hide() {
    this.root.hidden = true;
    holdPictureHeight(false);
    this.cancel();
  }

  /** Remember where the strip is on screen now (the finger is on it). */
  private pin() {
    this.anchor = { top: this.root.getBoundingClientRect().top, until: performance.now() + ANCHOR_MS };
  }

  /** The picture changed height: scroll so the strip stays where the finger left it. */
  private keepInPlace() {
    const a = this.anchor;
    if (!a || this.root.hidden) return;
    if (performance.now() > a.until) {
      this.anchor = null;
      return;
    }
    const delta = this.root.getBoundingClientRect().top - a.top;
    if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
  }

  /** Close the editor (a new photo). */
  private cancel() {
    clearTimeout(this.trail);
    clearTimeout(this.hold);
    this.trail = this.hold = 0;
    this.pendingValue = null;
    this.dragging = false;
  }

  private field = () => this.fields.find((f) => f.key === this.open);

  private setOpen(key: QuickKey | null, scroll = true) {
    if (key !== this.open) this.cancel();
    this.open = key;
    for (const pill of this.pills.querySelectorAll<HTMLButtonElement>('.quick-pill')) {
      const k = pill.dataset.key as QuickKey;
      const f = this.fields.find((x) => x.key === k)!;
      pill.classList.toggle('on', k === key);
      pill.classList.toggle('set', this.entered.has(k));
      pill.setAttribute('aria-expanded', String(k === key));
      const v = this.values[k];
      pill.querySelector('.qp-val')!.textContent = v === undefined || !Number.isFinite(v) ? '–' : showValue(f, v);
    }
    const f = this.field();
    this.edit.hidden = !f;
    // While a number is being changed the picture above never gets shorter (the buttons would jump up under the finger).
    holdPictureHeight(!!f && !this.root.hidden);
    if (!f) return;
    this.label.textContent = f.label;
    this.unit.textContent = f.unit;
    this.input.setAttribute('aria-label', `${f.label} in ${f.unit}`);
    this.range.setAttribute('aria-label', f.label);
    const v = this.values[f.key];
    if (v !== undefined && Number.isFinite(v)) this.show(f, v, true);
    // The opened row may reach below the screen: bring it up, keeping the picture in sight.
    if (scroll) this.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Show `v` for the open field (pill, number box, slider); `quiet` = only display, else also send it (thinned). */
  private show(f: QuickField, v: number, quiet: boolean) {
    if (document.activeElement !== this.input) {
      this.input.value = showNum(v, f.digits);
      this.input.classList.remove('bad');
    }
    if (!this.dragging || !quiet) {
      const pos = sliderScale(f).toPos(v);
      if (!this.dragging) this.range.value = String(Math.round(pos * 1000));
      this.range.style.setProperty('--fill', `${pos * 100}%`);
    }
    const pill = this.pills.querySelector<HTMLElement>(`.quick-pill[data-key="${f.key}"] .qp-val`);
    if (pill) pill.textContent = showValue(f, v);
    if (quiet) return;
    this.values[f.key] = v;
    this.send(f.key, v);
  }

  private pendingValue: { key: QuickKey; v: number } | null = null;
  private get pending() {
    return !!this.pendingValue || this.dragging;
  }

  /** Leading + trailing throttle: the first change goes at once, then at most one rebuild per DRAG_MS. */
  private send(key: QuickKey, v: number) {
    this.pendingValue = { key, v };
    const wait = DRAG_MS - (performance.now() - this.lastSent);
    if (wait <= 0 && !this.trail) this.flush();
    else if (!this.trail) this.trail = window.setTimeout(() => ((this.trail = 0), this.flush()), Math.max(0, wait));
  }

  /** Send the waiting value now. */
  private flush() {
    clearTimeout(this.trail);
    this.trail = 0;
    const p = this.pendingValue;
    if (!p) return;
    this.pendingValue = null;
    this.lastSent = performance.now();
    if (this.anchor) this.anchor.until = performance.now() + ANCHOR_MS;
    const msg = this.host.enter(p.key, p.v);
    if (msg) this.refuse(msg);
  }

  private step(dir: 1 | -1) {
    const f = this.field();
    if (!f) return;
    haptic();
    const v = this.values[f.key];
    const from = v !== undefined && Number.isFinite(v) ? v : f.min;
    const next = nudge(f, from, dir);
    if (next !== from) this.show(f, next, false);
  }

  /** The small number box: Enter or leaving it applies (same range rule as the boxes below). */
  private typed() {
    const f = this.field();
    if (!f) return;
    const text = this.input.value.trim().replace(',', '.');
    const now = this.values[f.key];
    if (text === '' || (now !== undefined && text === showNum(now, f.digits))) {
      if (now !== undefined) this.input.value = showNum(now, f.digits);
      return;
    }
    const v = Number(text);
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text) || !Number.isFinite(v)) {
      this.refuse(`Type a number`);
      return;
    }
    this.lastSent = 0;
    this.input.classList.remove('bad');
    this.pendingValue = { key: f.key, v };
    this.flush();
  }

  /** Refused: red number box, the reason in place of the label for a moment. */
  private refuse(msg: string) {
    const f = this.field();
    this.input.classList.add('bad');
    this.label.textContent = msg;
    this.label.classList.add('bad');
    window.setTimeout(() => {
      this.label.classList.remove('bad');
      if (f && this.open === f.key) this.label.textContent = f.label;
    }, 2500);
  }
}

function haptic() {
  navigator.vibrate?.(10);
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = `
  .quick { background: #fff; border-top: 2px solid #e5e5e5; padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
  .quick[hidden] { display: none; }
  .quick-pills { display: flex; flex-wrap: wrap; gap: 6px; }
  .quick-pill {
    flex: 1 1 auto; min-width: 0; min-height: 40px; padding: 0 12px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    border-radius: 999px; border: 2px solid #e5e5e5; border-bottom-width: 4px; background: #fff; color: #3c3c3c;
    font: inherit; font-size: 14px; font-weight: 800; white-space: nowrap; cursor: pointer; -webkit-tap-highlight-color: transparent;
    font-variant-numeric: tabular-nums; transition: transform 0.05s;
  }
  .quick-pill:active { transform: translateY(2px); border-bottom-width: 2px; }
  .quick-pill .qp-name { color: #777; }
  .quick-pill .qp-val { font-weight: 900; }
  .quick-pill.set .qp-val { color: #1899d6; }
  .quick-pill.on { border-color: #1cb0f6; background: #ddf4ff; color: #1899d6; }
  .quick-pill.on .qp-name { color: #1899d6; }
  .quick-edit { display: flex; align-items: center; gap: 8px; }
  .quick-edit[hidden] { display: none; }
  .quick-step {
    flex: none; width: 44px; height: 44px; border-radius: 14px; border: 0; border-bottom: 4px solid #1899d6; background: #1cb0f6;
    color: #fff; font: inherit; font-size: 26px; font-weight: 900; line-height: 1; cursor: pointer; touch-action: manipulation;
    -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none; transition: transform 0.05s;
  }
  .quick-step:active { transform: translateY(2px); border-bottom-width: 2px; }
  .quick-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .quick-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 26px; }
  .quick-label { font-size: 13px; font-weight: 800; color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .quick-label.bad { color: #ea2b2b; }
  .quick-num { display: inline-flex; align-items: baseline; gap: 3px; flex: none; }
  .quick-input {
    width: 58px; padding: 2px 6px; border: 2px solid #e5e5e5; border-radius: 10px; background: #f7f7f7; outline: 0; text-align: right;
    font: inherit; font-size: 16px; font-weight: 900; color: #3c3c3c; font-variant-numeric: tabular-nums;
  }
  .quick-input:focus { border-color: #1cb0f6; background: #fff; }
  .quick-input.bad { border-color: #ff4b4b; background: #fff0f0; }
  .quick-unit { font-size: 13px; font-weight: 800; color: #777; }
  .quick-range {
    --fill: 50%; -webkit-appearance: none; appearance: none; width: 100%; height: 28px; margin: 0; background: transparent; cursor: pointer;
    touch-action: none;
  }
  .quick-range::-webkit-slider-runnable-track {
    height: 12px; border-radius: 999px; background: linear-gradient(to right, #58cc02 var(--fill), #e5e5e5 var(--fill));
  }
  .quick-range::-moz-range-track { height: 12px; border-radius: 999px; background: #e5e5e5; }
  .quick-range::-moz-range-progress { height: 12px; border-radius: 999px; background: #58cc02; }
  .quick-range::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 26px; height: 26px; margin-top: -7px; border-radius: 50%;
    background: #fff; border: 3px solid #e5e5e5; border-bottom-width: 5px;
  }
  .quick-range::-moz-range-thumb { width: 22px; height: 22px; border-radius: 50%; background: #fff; border: 3px solid #e5e5e5; }
  `;
  document.head.appendChild(el);
}
