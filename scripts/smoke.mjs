#!/usr/bin/env node
// npm run smoke: "does every drawing still move?" in one command (run `npm run build` first).
//
// Serves dist/ with `vite preview`, opens it once in headless Chrome (DevTools protocol, no extra packages) with
// ?offline&debug&sw=0 and feeds every photo in samples/generated/ (*-gen-*.jpg and judge-*.jpg) to the file input one
// after another (the app's "new photo" path). For each photo it records
//   1. the shape-based guess ("[ai] offline guess: <type>") against the type expected from the file name,
//   2. whether the progress line reaches Alive (all four dots done),
//   3. whether the rigid bodies move: ?debug outlines every Matter.js body and constraint on the stage; those outline
//      points (world px, caught from the canvas calls, see PROBE_JS) are read 2.0, 2.5, 3.0, 3.5 and 4.0 s after Alive
//      (the 1.4 s morph is over by then) and compared with the first read (several reads, so a pendulum back at the
//      same spot after one period still counts),
//   4. page errors and console.error calls (must be 0).
// Prints a table, writes the full result as JSON (SMOKE_DIR, default <tmpdir>/whiteboard-alive-smoke) and exits 1 when
// any photo has the wrong type, does not reach Alive, does not move, or logs an error.
//
//   npm run smoke                 every photo
//   npm run smoke -- pendulum     only photos whose name contains "pendulum"
// Env: SMOKE_PORT (5230), SMOKE_DIR, CHROME_PATH.
//
// Network.enable is not used: it stalls the page while the 10 MB opencv.js streams in. Requests are read from
// performance.getEntriesByType('resource') instead.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 5230);
const WORK = path.resolve(process.env.SMOKE_DIR || path.join(os.tmpdir(), 'whiteboard-alive-smoke'));
const URL_ = `http://127.0.0.1:${PORT}/whiteboard-alive/?offline&debug&sw=0`;
const SAMPLES = path.join(ROOT, 'samples', 'generated');

/** World px some body outline point must travel (from its 2.0 s place) for the scene to count as moving. */
const MOVE_MIN = 2;
/** When the body outlines are read, ms after Alive. */
const SNAP_AT = [2000, 2500, 3000, 3500, 4000];
/** Longest wait for Alive (the first photo also waits for opencv.js). */
const ALIVE_TIMEOUT_FIRST = 90_000;
const ALIVE_TIMEOUT = 25_000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Type the file name promises: pendulum-gen-01 -> pendulum, roll-gen -> incline, judge-<type>-... -> <type>. */
export function expectedFor(file) {
  const m = /^judge-([a-z]+)/.exec(file) || /^([a-z]+)-gen-/.exec(file);
  if (!m) return null;
  return m[1] === 'roll' ? 'incline' : m[1];
}

function listPhotos(filters) {
  return fs
    .readdirSync(SAMPLES)
    .filter((f) => /\.jpe?g$/i.test(f) && (/-gen-/.test(f) || /^judge-/.test(f)))
    .filter((f) => !filters.length || filters.some((s) => f.includes(s)))
    .sort();
}

// ---- Processes ------------------------------------------------------------------------------------------------

const cleanups = [];
async function cleanup() {
  while (cleanups.length) {
    try {
      await cleanups.pop()();
    } catch {}
  }
}
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    cleanup().finally(() => process.exit(130));
  });

function killAndWait(child, ms = 3000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve();
    }, ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {}
  });
}

async function startPreview() {
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  cleanups.push(() => killAndWait(child));
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`vite preview exited:\n${out}`);
    try {
      const r = await fetch(URL_);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`vite preview did not answer on port ${PORT}:\n${out}`);
}

async function startChrome() {
  const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error('Chrome not found (set CHROME_PATH)');
  fs.mkdirSync(WORK, { recursive: true });
  const profile = fs.mkdtempSync(path.join(WORK, 'chrome-profile-'));
  cleanups.push(async () => {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        if (!fs.existsSync(profile)) return;
      } catch {}
      await sleep(300);
    }
  });
  const child = spawn(
    exe,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1280,1000',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  cleanups.push(() => killAndWait(child));
  const portFile = path.join(profile, 'DevToolsActivePort');
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Chrome exited (${child.exitCode})`);
    if (fs.existsSync(portFile)) {
      const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (port) {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
        const page = list.find((t) => t.type === 'page');
        if (page) return page.webSocketDebuggerUrl;
      }
    }
    await sleep(200);
  }
  throw new Error('Chrome did not open its DevTools port');
}

// ---- DevTools protocol ----------------------------------------------------------------------------------------

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('DevTools WebSocket failed'));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  cleanups.push(() => ws.close());
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const my = ++id;
        pending.set(my, { resolve, reject });
        ws.send(JSON.stringify({ id: my, method, params }));
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
  };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const PROGRESS_JS = `(() => {
  const w = document.querySelector('.progress-line');
  return w ? { now: Number(w.getAttribute('aria-valuenow')), text: w.getAttribute('aria-valuetext'), failed: w.classList.contains('failed') } : null;
})()`;

/**
 * Installed before the page loads: Simulation.drawDebug (sim.ts, ?debug) strokes every body outline and constraint in
 * rgba(255,0,80,0.8) as moveTo/lineTo in world coordinates, synchronously at the end of each frame. Those points are
 * collected per frame (a microtask closes the frame) into window.__smokeFrame, so the test reads where the rigid
 * bodies are without the app exposing anything in a production build. Other strokes (the clean figure, labels) are
 * ignored, so a fading ghost or a coloured figure cannot look like motion.
 */
const PROBE_JS = `(() => {
  const P = CanvasRenderingContext2D.prototype;
  const RED = 'rgba(255,0,80,0.8)';
  const desc = Object.getOwnPropertyDescriptor(P, 'strokeStyle');
  let on = null, frame = null;
  window.__smokeFrames = 0;
  Object.defineProperty(P, 'strokeStyle', {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set(v) {
      if (v === RED) {
        on = this;
        if (!frame) {
          frame = [];
          queueMicrotask(() => { window.__smokeFrame = frame; window.__smokeFrames++; frame = null; on = null; });
        }
      } else if (on === this) on = null;
      desc.set.call(this, v);
    },
  });
  for (const name of ['moveTo', 'lineTo']) {
    const orig = P[name];
    P[name] = function (x, y) {
      if (on === this && frame) frame.push(x, y);
      return orig.call(this, x, y);
    };
  }
})()`;

/** Debug points of the last frame; `base` keeps them, otherwise returns the largest move (world px) since then. */
const motionJs = (base) => `(() => {
  const f = window.__smokeFrame || [];
  if (${base}) { window.__smokeBase = f.slice(); return { n: f.length / 2, move: 0 }; }
  const b = window.__smokeBase || [];
  if (!f.length || !b.length) return { n: f.length / 2, move: 0 };
  if (f.length !== b.length) return { n: f.length / 2, move: 1e9 };
  let move = 0;
  for (let i = 0; i < f.length; i += 2) move = Math.max(move, Math.hypot(f[i] - b[i], f[i + 1] - b[i + 1]));
  return { n: f.length / 2, move: Math.round(move * 10) / 10 };
})()`;

const STAGES = ['Ready', 'Lines', 'Understanding', 'Alive'];

// ---- Main -----------------------------------------------------------------------------------------------------

async function main() {
  const filters = process.argv.slice(2);
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('dist/ is missing: run `npm run build` first.');
    return 2;
  }
  const photos = listPhotos(filters);
  if (!photos.length) {
    console.error('No photos in samples/generated/ match.');
    return 2;
  }
  const started = Date.now();
  await startPreview();
  const cdp = await connect(await startChrome());

  /** Current photo's record (errors and logs go there; before the first photo they belong to the page load). */
  const loadErrors = [];
  let cur = null;
  const pushError = (text) => (cur ? cur.errors : loadErrors).push(text.slice(0, 300));
  cdp.on('Runtime.exceptionThrown', (p) => {
    const e = p.exceptionDetails;
    pushError(`pageerror: ${e.exception?.description ?? e.text}`);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(' ');
    if (p.type === 'error') pushError(`console.error: ${text}`);
    if (!cur) return;
    const g = /^\[ai\] offline guess: (\w+)/.exec(text);
    if (g) cur.guess = g[1];
    if (/^\[vision\] \d+ contours in/.test(text)) cur.vision = text.split(' ').slice(0, 5).join(' ');
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_JS });
  const loaded = new Promise((r) => cdp.on('Page.loadEventFired', r));
  await cdp.send('Page.navigate', { url: URL_ });
  await loaded;
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId: fileNode } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  if (!fileNode) throw new Error('#file input not found');

  const results = [];
  for (const [i, file] of photos.entries()) {
    cur = { file, expected: expectedFor(file), guess: null, vision: null, stage: null, alive: false, moved: false, maxMove: 0, points: 0, errors: [], ms: 0 };
    const t0 = Date.now();
    await cdp.send('DOM.setFileInputFiles', { nodeId: fileNode, files: [path.join(SAMPLES, file)] });

    // Alive = all four dots done, after this photo's guess was logged (so the previous photo's "Done" is not read).
    const until = t0 + (i === 0 ? ALIVE_TIMEOUT_FIRST : ALIVE_TIMEOUT);
    let tAlive = 0;
    let last = null;
    while (Date.now() < until) {
      last = await evaluate(cdp, PROGRESS_JS);
      if (last?.failed) break;
      if (cur.guess && last?.now >= STAGES.length) {
        tAlive = Date.now();
        break;
      }
      await sleep(100);
    }
    cur.alive = !!tAlive;
    cur.stage = tAlive ? 'Alive' : last?.failed ? `error at ${STAGES[Math.min(last.now, 3)]}` : `stuck: ${last?.text ?? 'no progress'}`;

    if (tAlive) {
      for (const [k, at] of SNAP_AT.entries()) {
        const wait = tAlive + at - Date.now();
        if (wait > 0) await sleep(wait);
        const m = await evaluate(cdp, motionJs(k === 0));
        if (k === 0) cur.points = m.n;
        else cur.maxMove = Math.max(cur.maxMove, m.move);
      }
      cur.moved = cur.points > 0 && cur.maxMove >= MOVE_MIN;
    }
    cur.ms = Date.now() - t0;
    cur.ok = cur.guess === cur.expected && cur.alive && cur.moved && !cur.errors.length;
    results.push(cur);
    printRow(results.length, cur);
  }
  cur = null;

  const gemini = await evaluate(
    cdp,
    `performance.getEntriesByType('resource').filter((e) => /generativelanguage/.test(e.name)).length`,
  ).catch(() => null);
  const resources = await evaluate(cdp, `performance.getEntriesByType('resource').length`).catch(() => null);
  const pass = results.filter((r) => r.ok).length;
  const seconds = Math.round((Date.now() - started) / 1000);
  const allOk = pass === results.length && !loadErrors.length;

  console.log('');
  if (loadErrors.length) console.log(`Errors while loading the page:\n  ${loadErrors.join('\n  ')}`);
  for (const r of results.filter((x) => !x.ok)) {
    const why = [];
    if (r.guess !== r.expected) why.push(`guessed ${r.guess ?? 'nothing'}, expected ${r.expected}`);
    if (!r.alive) why.push(r.stage);
    else if (!r.moved) why.push(`did not move (largest move ${r.maxMove} px, ${r.points} outline points)`);
    for (const e of r.errors) why.push(e);
    console.log(`FAIL ${r.file}: ${why.join('; ')}`);
  }
  console.log(`${pass}/${results.length} passed in ${seconds}s${gemini ? ` (WARNING: ${gemini} Gemini requests)` : ''}`);

  fs.mkdirSync(WORK, { recursive: true });
  const out = path.join(WORK, `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(
    out,
    JSON.stringify({ url: URL_, when: new Date().toISOString(), seconds, pass, total: results.length, loadErrors, geminiRequests: gemini, resources, results }, null, 2),
  );
  console.log(`JSON: ${out}`);
  return allOk ? 0 : 1;
}

function printRow(n, r) {
  if (n === 1) {
    console.log(['#', 'file', 'expected', 'guess', 'stage', 'moved', 'errors', 'time', 'result'].map((s, i) => s.padEnd(WIDTHS[i])).join(' '));
    console.log(WIDTHS.map((w) => '-'.repeat(w)).join(' '));
  }
  const cells = [
    String(n),
    r.file,
    r.expected ?? '?',
    r.guess ?? '-',
    r.stage,
    r.alive ? (r.moved ? `yes ${r.maxMove >= 1e9 ? 'count changed' : `${r.maxMove}px`}` : `NO ${r.maxMove}px`) : '-',
    String(r.errors.length),
    `${(r.ms / 1000).toFixed(1)}s`,
    r.ok ? 'ok' : 'FAIL',
  ];
  console.log(cells.map((s, i) => s.padEnd(WIDTHS[i])).join(' '));
}
const WIDTHS = [3, 22, 10, 10, 12, 17, 6, 6, 6];

main()
  .catch((err) => {
    console.error(err?.stack ?? err);
    return 2;
  })
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  });
