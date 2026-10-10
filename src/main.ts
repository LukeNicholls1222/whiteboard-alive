import './style.css';
import { aiPlan, analyze, askGemini, hasApiKey, offlineAnalysis } from './ai';
import { cachedAnalysis, EXAMPLES, exampleBlob, exampleThumb, fingerprint, preloadExamples } from './examples';
import { createControls, launchSpeedTune } from './controls';
import { annotationsFrom, fieldsFor, type Entries } from './entries';
import { LiveGraph } from './graph';
import { QuantityLabels } from './notes';
import { buildScene } from './scenes';
import { AIOverlay } from './overlay';
import { Simulation } from './sim';
import { ProgressLine } from './progress';
import { VelocityArrows } from './vectors';
import type { Analysis, BuiltScene, SceneInput } from './types';
import { annotate, extractContours, loadOpenCV, toWorkingCanvas, type VisionResult } from './vision';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('file');
const status = $<HTMLDivElement>('status');
const stage = $<HTMLCanvasElement>('stage');
const explain = $<HTMLParagraphElement>('explain');

let sim: Simulation | null = null;
const overlay = new AIOverlay(stage, $<HTMLButtonElement>('ai-toggle'));
/** Inputs of the scene on screen, kept so build-time params (e.g. launch speed) can rebuild it. */
let current: SceneInput | null = null;
/** "Your numbers" for the photo on screen; emptied for every new photo. */
let entered: Entries = {};

const controls = createControls($<HTMLElement>('controls'), {
  apply(set, rebuild) {
    if (!current) return;
    Object.assign(current.analysis.params, set);
    if (rebuild) {
      const input = current;
      startScene(input).then((scene) => {
        if (scene && input === current) controls.numbers(fieldsFor(scene, input.analysis), entered);
      });
    } else sim?.setParams(set);
  },
  enter(entries, reset) {
    if (!current) return;
    const input = current;
    const a = input.analysis;
    // Typed numbers go where the scenes read them (noteFor); no AI call. The launch speed is also its slider's value.
    const hadSpeed = entered.launchSpeed !== undefined;
    entered = entries;
    a.annotations = annotationsFrom(entries);
    if (entries.launchSpeed !== undefined) a.params.speed = entries.launchSpeed;
    else if (reset || hadSpeed) delete a.params.speed;
    mark('numbers');
    startScene(input).then((scene) => {
      if (scene && input === current) showControls(scene, a);
    });
  },
});
const arrows = new VelocityArrows();
arrows.mountToggle($<HTMLElement>('controls'));
/** Physical values next to the parts ("L = 0.42 m assumed") and the slow-motion badge. */
const notes = new QuantityLabels(stage.parentElement!);
arrows.avoid = () => notes.boxes;
if (import.meta.env.DEV) (window as any).__wa = { controls, arrows, notes, events: [], get sim() { return sim; }, get current() { return current; }, get entered() { return entered; } };
/** Dev-only timeline of a photo's life (photo picked, moving, AI answer...) for the headless tests. */
function mark(e: string, forGen = gen) {
  if (import.meta.env.DEV) (window as any).__wa.events.push({ e, t: Math.round(performance.now()), gen: forGen });
}

/** Bumped for every new photo; anything async that finishes for an older photo is dropped. */
let gen = 0;

interface StartOptions {
  /** Play "what the AI saw" over the paper first. */
  intro?: boolean;
  /** Already built scene for `input`. */
  scene?: BuiltScene;
  /** Photo this start belongs to: if a newer photo came in during the intro, nothing starts. */
  forGen?: number;
}

async function startScene(input: SceneInput, opts: StartOptions = {}): Promise<BuiltScene | null> {
  const scene = opts.scene ?? buildScene(input);
  sim?.stop();
  // Show what the AI understood on top of the paper, then let it come alive.
  if (opts.intro) await overlay.playIntro({ ...input, scene });
  if (opts.forGen !== undefined && opts.forGen !== gen) return null;
  sim?.stop();
  sim = new Simulation(stage, scene, input.width, input.height);
  // The sim is the single source of truth: any change (incl. the Moon switch) flows back to the
  // stored params (used on rebuild) and to the sliders / chips.
  sim.paramListeners.push((p) => {
    Object.assign(input.analysis.params, p);
    controls.sync(p);
  });
  sim.setParams(input.analysis.params);
  graph.attach(sim, input.analysis.diagram);
  // Value labels first, so the velocity arrows draw on top of them.
  notes.attach(sim, input.analysis);
  arrows.attach(sim);
  sim.start();
  mark('moving');
  return scene;
}

/**
 * Sliders and "Your numbers" for a freshly built scene (buildScene drops to the fallback when the chosen builder
 * fails). `fresh` = a new photo: the number boxes start empty.
 */
function showControls(scene: BuiltScene, analysis: Analysis, fresh = false) {
  // The launch speed slider is in this drawing's m/s, ranged around the speed that lands in the picture.
  const ls = scene.physics?.launchSpeed;
  // The air resistance switch shows only for scenes that read params.airDrag (pendulum, projectile).
  controls.show(
    scene.label === 'Falling objects' ? 'fallback' : analysis.diagram,
    analysis.params,
    ls ? launchSpeedTune(ls.fit, ls.value) : {},
    scene.physics?.airDrag,
  );
  controls.numbers(fieldsFor(scene, analysis), entered, fresh);
}
const graph = new LiveGraph(stage.parentElement!);

// Start loading OpenCV right away so it is ready by the time a photo is picked.
const cvPromise = loadOpenCV();
// Once OpenCV is in, keep the example photos and answers in memory so the gallery works offline.
cvPromise.then(preloadExamples, preloadExamples);

type Step = 'load' | 'contours' | 'ai' | 'run';
const ORDER: Step[] = ['load', 'contours', 'ai', 'run'];
/** One line, four dots. Short labels so it fits a 390 px phone; `ms` = how long the line creeps toward that dot. */
const progress = new ProgressLine(status, [
  { label: 'Ready', ms: 2500 },
  { label: 'Lines', ms: 1500 },
  { label: 'Understanding', ms: 20000 }, // Gemini's whole time budget (TIMEOUT_MS in ai.ts)
  { label: 'Alive', ms: 2000 }, // the "what the AI saw" intro
]);
progress.step(-1);

function setStep(step: Step | 'done' | 'error', detail = '') {
  if (step === 'error') return progress.error(detail);
  progress.step(step === 'done' ? ORDER.length : ORDER.indexOf(step));
}

/** Gemini failed or timed out: the scene is built from the shape-based guess, and the status says so. */
const showGuessOnly = () => progress.warn(ORDER.indexOf('ai'), 'Using a quick guess');

/**
 * While Gemini reads the drawing nothing moves: the stage shows the still paper and its lines glow softly one
 * after another (top to bottom), so the screen never looks frozen. Replaced by the intro once the answer is in.
 */
let waitRaf = 0;
function showWaiting(v: VisionResult) {
  cancelAnimationFrame(waitRaf);
  const ctx = stage.getContext('2d')!;
  const lines = v.contours
    .filter((k) => k.points.length >= 2 && k.bbox.w + k.bbox.h > 20)
    .sort((a, b) => b.inkPixels - a.inkPixels)
    .slice(0, 12)
    .sort((a, b) => a.centroid.y - b.centroid.y || a.centroid.x - b.centroid.x);
  const PER = 520; // ms between two lines lighting up; each glow lasts 2 PER
  const cycle = (lines.length + 2) * PER;
  const t0 = performance.now();
  const frame = (now: number) => {
    const dpr = window.devicePixelRatio || 1;
    const cssW = stage.clientWidth;
    const cssH = (cssW * v.height) / v.width;
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (stage.width !== pw || stage.height !== ph) {
      stage.width = pw;
      stage.height = ph;
      stage.style.height = `${cssH}px`;
    }
    const s = stage.width / v.width;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(v.paper, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = (6 * dpr) / s;
    ctx.strokeStyle = '#1cb0f6';
    const t = ((now - t0) % cycle) / PER;
    lines.forEach((k, i) => {
      const local = t - i;
      if (local <= 0 || local >= 2) return;
      ctx.globalAlpha = 0.4 * Math.sin((Math.PI * local) / 2);
      ctx.beginPath();
      k.points.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    waitRaf = requestAnimationFrame(frame);
  };
  frame(t0);
}
function stopWaiting() {
  cancelAnimationFrame(waitRaf);
  waitRaf = 0;
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) {
    selectExample(null);
    run(file).finally(() => (fileInput.value = ''));
  }
});

// ?src=<image url> runs the pipeline on a hosted image (used for testing with samples/).
const srcParam = new URLSearchParams(location.search).get('src');
if (srcParam) fetch(srcParam).then((r) => r.blob()).then((b) => run(b));

// "Or try one of ours": built-in photos with the AI answer saved, so they always run (no network AI call).
const gallery = $<HTMLDivElement>('examples');
gallery.innerHTML = EXAMPLES.map(
  (e) => `<button type="button" class="example" data-name="${e.name}">
    <img src="${exampleThumb(e.name)}" alt="${e.title} drawing" loading="lazy" decoding="async" />
    <span>${e.title}</span>
  </button>`,
).join('');
gallery.addEventListener('click', async (ev) => {
  const card = (ev.target as HTMLElement).closest<HTMLButtonElement>('.example');
  if (!card || busy) return;
  const name = card.dataset.name!;
  selectExample(name);
  stage.parentElement!.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    const blob = await exampleBlob(name);
    await run(blob, name);
  } catch (err) {
    console.error(err);
    setStep('error', 'That example did not load. Try another one!');
  }
});
function selectExample(name: string | null) {
  gallery.querySelectorAll<HTMLButtonElement>('.example').forEach((b) => b.classList.toggle('on', b.dataset.name === name));
}

let busy = false;

async function run(file: Blob, example?: string) {
  const my = ++gen;
  const stale = () => my !== gen;
  busy = true;
  mark('photo');
  // An older photo may still be waiting for Gemini: its glowing lines must not draw over this one.
  stopWaiting();
  try {
    overlay.reset();
    notes.reset();
    setStep('load');
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const photo = toWorkingCanvas(bitmap, bitmap.width, bitmap.height);
    const cv = await cvPromise;
    if (stale()) return;

    setStep('contours');
    await nextFrame();
    if (stale()) return;
    const t0 = performance.now();
    const vision = extractContours(cv, photo);
    console.log(`[vision] ${vision.contours.length} contours in ${Math.round(performance.now() - t0)}ms`, vision.contours);

    setStep('ai');
    const t1 = performance.now();
    const annotated = annotate(vision.paper, vision.contours);

    let analysis: Analysis;
    if (!example && aiPlan().kind === 'gemini') {
      // Nothing moves before the drawing is understood. Gemini takes 3-15 s (at most 20 s): meanwhile the stage
      // shows the still paper with its lines glowing in turn and the "Understanding" dot pulsing. The shape-based
      // guess is worked out in the meantime, so a failure or timeout can start on it at once.
      sim?.stop();
      sim = null;
      controls.hide();
      explain.textContent = '';
      showWaiting(vision);
      mark('waiting');
      // Another photo or example may replace this one while it waits; the generation check drops the old answer.
      busy = false;
      const pending = askGemini(annotated, vision.contours);
      await nextFrame();
      if (stale()) return;
      const guess = offlineAnalysis(annotated, vision.contours);
      console.log(`[ai] quick guess ${guess.diagram} ready in ${Math.round(performance.now() - t1)}ms, waiting for Gemini`);
      const ai = await pending.catch(() => null);
      if (stale()) {
        console.log('[ai] answer for an older photo, ignored');
        mark('ai-stale', my);
        return;
      }
      stopWaiting();
      if (ai) {
        mark('ai-answer');
        analysis = ai;
      } else {
        console.log(`[ai] no answer after ${Math.round(performance.now() - t1)}ms, using the quick guess`);
        mark('ai-failed');
        showGuessOnly();
        analysis = guess;
      }
    } else {
      analysis = example
        ? await cachedAnalysis(example, vision.contours).catch((err) => {
            console.warn(err);
            return offlineAnalysis(annotated, vision.contours);
          })
        : await analyze(annotated, vision.contours);
      if (stale()) return;
    }
    console.log(`[ai] ${analysis.source} ${Math.round(performance.now() - t1)}ms`, analysis);
    if (import.meta.env.DEV) (window as any).__wa.last = { analysis: structuredClone(analysis), fingerprint: fingerprint(vision.contours, analysis) };

    setStep('run');
    await nextFrame();
    if (stale()) return;
    // A new photo starts with every number box empty: nothing typed for the last drawing carries over.
    entered = {};
    analysis.annotations = [];
    current = { ...vision, analysis };
    const scene = await startScene(current, { intro: true, forGen: my });
    if (!scene) return;
    showControls(scene, analysis, true);
    setStep('done');
    explain.textContent = analysis.explanation || `${scene.label}${analysis.source === 'heuristic' && !hasApiKey() ? ' (offline mode)' : ''}`;
  } catch (err) {
    console.error(err);
    if (!stale()) setStep('error', 'Something went wrong. Try another photo!');
  } finally {
    if (!stale()) busy = false;
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
