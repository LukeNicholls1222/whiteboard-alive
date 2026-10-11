// Hedged requests: ask the next model alongside a slow one instead of waiting it out (see askGemini in ai.ts).

export interface HedgeOptions {
  /** No answer this long after the last start: start the next attempt alongside the running ones. */
  hedgeMs: number;
  /** Whole budget: after this, null (every running attempt is aborted). */
  totalMs: number;
  /** Most attempts running at once; when full, the next one starts as soon as one fails. */
  maxInFlight: number;
}

/**
 * Starts attempt 0; whenever the newest attempt fails, or gives no answer within `hedgeMs`, starts the next one
 * (attempts already running keep going). The first success wins and every other attempt is aborted through its
 * signal. Resolves null when all `count` attempts fail or `totalMs` runs out. Never rejects.
 */
export function firstSuccess<T>(
  count: number,
  attempt: (i: number, signal: AbortSignal) => Promise<T>,
  opts: HedgeOptions,
): Promise<T | null> {
  return new Promise((resolve) => {
    const ctrls: AbortController[] = [];
    let next = 0;
    let inFlight = 0;
    let done = false;
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(hedge);
      clearTimeout(end);
      for (const c of ctrls) c.abort();
      resolve(v);
    };
    const end = setTimeout(() => finish(null), opts.totalMs);
    const launch = () => {
      if (done) return;
      clearTimeout(hedge);
      if (next >= count) {
        if (!inFlight) finish(null);
        return;
      }
      if (inFlight >= opts.maxInFlight) return; // the next failure starts it
      const i = next++;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      inFlight++;
      Promise.resolve()
        .then(() => attempt(i, ctrl.signal))
        .then(finish, () => {
          inFlight--;
          launch();
        });
      if (next < count) hedge = setTimeout(launch, opts.hedgeMs);
    };
    launch();
  });
}
