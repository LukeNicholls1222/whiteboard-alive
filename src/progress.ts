// Progress line under the photo button: four dots on one thick rounded line (Duolingo-style).
// Done = green, the current step's dot pulses blue while the line creeps toward it (stops short at 95% and
// fills at once when the step finishes), a quick-guess fallback marks its dot orange, an error turns it red.

export interface ProgressStep {
  label: string;
  /** How long the line takes to creep to 95% of the way to this dot (the step's usual worst case). */
  ms: number;
}

const CREEP = 0.95;

export class ProgressLine {
  private built = false;
  private fills: HTMLElement[] = [];
  private dots: HTMLElement[] = [];
  private labels: HTMLElement[] = [];
  private subs: HTMLElement[] = [];
  private message!: HTMLElement;
  private wrap!: HTMLElement;
  /** Index of the step in progress; steps.length = all done. */
  private current = -1;
  private warns = new Map<number, string>();
  private failed = false;

  constructor(
    private root: HTMLElement,
    private steps: ProgressStep[],
  ) {}

  /** Step `index` is in progress (0 starts a new photo: everything back to grey). `steps.length` = all done. */
  step(index: number) {
    this.build();
    if (index <= 0 || index < this.current || this.failed) this.clear();
    const prev = this.current;
    this.current = index;
    this.fills.forEach((fill, j) => {
      const to = j + 1; // segment j leads to dot j + 1
      if (to < index) {
        // Finished: fill at once (from wherever the creep got to).
        if (fill.dataset.state !== 'full') this.setFill(fill, 1, 'width 0.25s ease-out', 'full');
      } else if (to === index && prev !== index) {
        this.creep(fill, this.steps[to].ms);
      }
    });
    this.paint();
  }

  /** Step `index` ended on a fallback: its dot turns orange with a short note under the label. */
  warn(index: number, note: string) {
    this.build();
    this.warns.set(index, note);
    this.paint();
  }

  /** Something failed at the current step: red dot, line frozen where it was, message under the line. */
  error(message: string) {
    this.build();
    this.failed = true;
    this.fills.forEach((fill) => {
      if (fill.dataset.state !== 'creep') return;
      const w = fill.getBoundingClientRect().width / (fill.parentElement!.getBoundingClientRect().width || 1);
      this.setFill(fill, w, 'none', 'stopped');
    });
    this.message.textContent = message;
    this.paint();
  }

  private clear() {
    this.warns.clear();
    this.failed = false;
    this.current = -1;
    this.message.textContent = '';
    for (const fill of this.fills) this.setFill(fill, 0, 'none', '');
  }

  private creep(fill: HTMLElement, ms: number) {
    this.setFill(fill, 0, 'none', 'creep');
    void fill.offsetWidth; // restart the transition from 0
    // Ease-out over the step's usual length: fast at first, still moving (slowly) near the end.
    fill.style.transition = `width ${ms}ms cubic-bezier(0.2, 0.6, 0.35, 1)`;
    fill.style.width = `${CREEP * 100}%`;
  }

  private setFill(fill: HTMLElement, frac: number, transition: string, state: string) {
    fill.style.transition = transition;
    fill.style.width = `${frac * 100}%`;
    fill.dataset.state = state;
  }

  private paint() {
    const k = this.current;
    this.wrap.classList.toggle('failed', this.failed);
    this.dots.forEach((dot, i) => {
      const state =
        this.failed && i === k ? 'error' : this.warns.has(i) && i <= k ? 'warn' : i < k ? 'done' : i === k ? 'active' : '';
      dot.className = `pl-dot ${state}`;
      this.labels[i].className = `pl-label ${state}`;
      this.subs[i].textContent = state === 'warn' ? this.warns.get(i)! : '';
    });
    const done = Math.min(k, this.steps.length);
    const now = this.steps[k]?.label;
    this.wrap.setAttribute('aria-valuenow', String(Math.max(0, done)));
    this.wrap.setAttribute(
      'aria-valuetext',
      this.failed ? this.message.textContent ?? '' : k < 0 ? 'Waiting for a photo' : now ? `${now}…` : 'Done',
    );
  }

  private build() {
    if (this.built) return;
    this.built = true;
    const n = this.steps.length;
    const el = (tag: string, cls: string, parent: HTMLElement) => {
      const e = document.createElement(tag);
      e.className = cls;
      parent.appendChild(e);
      return e;
    };
    this.root.textContent = '';
    this.wrap = el('div', 'progress-line', this.root);
    this.wrap.setAttribute('role', 'progressbar');
    this.wrap.setAttribute('aria-valuemin', '0');
    this.wrap.setAttribute('aria-valuemax', String(n));
    this.wrap.style.setProperty('--n', String(n));
    const track = el('div', 'pl-track', this.wrap);
    for (let j = 0; j < n - 1; j++) {
      const seg = el('div', 'pl-seg', track);
      seg.style.left = `${(j / (n - 1)) * 100}%`;
      seg.style.width = `${100 / (n - 1)}%`;
      this.fills.push(el('div', 'pl-fill', seg));
    }
    for (let i = 0; i < n; i++) {
      const dot = el('div', 'pl-dot', track);
      dot.style.left = `${(i / (n - 1)) * 100}%`;
      this.dots.push(dot);
    }
    const grid = el('div', 'pl-labels', this.wrap);
    this.steps.forEach((s, i) => {
      const label = el('span', 'pl-label', grid);
      label.textContent = s.label;
      label.style.gridColumn = String(i + 1);
      this.labels.push(label);
    });
    this.steps.forEach((_, i) => {
      const sub = el('span', 'pl-sub', grid);
      sub.style.gridColumn = String(i + 1);
      this.subs.push(sub);
    });
    this.message = el('span', 'pl-message', grid);
    this.message.setAttribute('role', 'alert');
  }
}
