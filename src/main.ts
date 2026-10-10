import './style.css';
import type Matter from 'matter-js';
import { aiPlan, analyze, askGemini, hasApiKey, offlineAnalysis } from './ai';
import { cachedAnalysis, EXAMPLES, exampleBlob, exampleThumb, fingerprint, preloadExamples } from './examples';
import { createControls, launchSpeedTune } from './controls';
import { LiveGraph } from './graph';
import { QuantityLabels } from './notes';
import { buildScene } from './scenes';
import { AIOverlay } from './overlay';
import { Simulation } from './sim';
import { VelocityArrows } from './vectors';
import type { Analysis, BuiltScene, SceneInput, SimParams } from './types';
import { annotate, extractContours, loadOpenCV, toWorkingCanvas } from './vision';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('file');
const status = $<HTMLDivElement>('status');
const stage = $<HTMLCanvasElement>('stage');
const explain = $<HTMLParagraphElement>('explain');

let sim: Simulation | null = null;
const overlay = new AIOverlay(stage, $<HTMLButtonElement>('ai-toggle'));
/** Inputs of the scene on screen, kept so build-time params (e.g. launch speed) can rebuild it. */
let current: SceneInput | null = null;

const controls = createControls($<HTMLElement>('controls'), {
  apply(set, rebuild) {
    if (!current) return;
    Object.assign(current.analysis.params, set);
    if (rebuild) startScene(current);
    else sim?.setParams(set);
  },
});
const arrows = new VelocityArrows();
arrows.mountToggle($<HTMLElement>('controls'));
/** Physical values next to the parts ("L = 0.42 m assumed") and the slow-motion badge. */
const notes = new QuantityLabels(stage.parentElement!);
arrows.avoid = () => notes.boxes;
if (import.meta.env.DEV) (window as any).__wa = { controls, arrows, notes, events: [], get sim() { return sim; }, get current() { return current; } };
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
  /** Keep the running scene moving under the intro and swap at its end (the AI answer replacing the quick guess). */
  crossfade?: boolean;
}

async function startScene(input: SceneInput, opts: StartOptions = {}): Promise<BuiltScene | null> {
  const scene = opts.scene ?? buildScene(input);
  if (!opts.crossfade) sim?.stop();
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

/** Sliders for a freshly built scene (buildScene drops to the fallback when the chosen builder fails). */
function showControls(scene: BuiltScene, analysis: Analysis) {
  // The launch speed slider is in this drawing's m/s, ranged around the speed that lands in the picture.
  const ls = scene.physics?.launchSpeed;
  // The air resistance switch shows only for scenes that read params.airDrag (pendulum, projectile).
  controls.show(
    scene.label === 'Falling objects' ? 'fallback' : analysis.diagram,
    analysis.params,
    ls ? launchSpeedTune(ls.fit, ls.value) : {},
    scene.physics?.airDrag,
  );
}
const graph = new LiveGraph(stage.parentElement!);

// Start loading OpenCV right away so it is ready by the time a photo is picked.
const cvPromise = loadOpenCV();
// Once OpenCV is in, keep the example photos and answers in memory so the gallery works offline.
cvPromise.then(preloadExamples, preloadExamples);

type Step = 'load' | 'contours' | 'ai' | 'run';
const STEPS: Record<Step, string> = {
  load: 'Getting ready',
  contours: 'Finding your lines',
  ai: 'Understanding the drawing',
  run: 'Bringing it to life',
};

const ORDER: Step[] = ['load', 'contours', 'ai', 'run'];
type StepState = 'done' | 'active' | 'warn' | '';

function renderSteps(states: StepState[], labels: Partial<Record<Step, string>> = {}) {
  status.innerHTML = ORDER.map((s, i) => `<span class="step ${states[i]}">${labels[s] ?? STEPS[s]}</span>`).join('');
}

function setStep(step: Step | 'done' | 'error', detail = '') {
  if (step === 'error') {
    status.innerHTML = `<span class="step error">${detail}</span>`;
    return;
  }
  const idx = step === 'done' ? ORDER.length : ORDER.indexOf(step);
  renderSteps(ORDER.map((_, i) => (i < idx ? 'done' : i === idx ? 'active' : '')));
}

/** Moving on the shape-based guess while Gemini is still reading the drawing (the AI step keeps pulsing). */
const showGuessing = () => renderSteps(['done', 'done', 'active', 'done'], { ai: 'Quick guess · AI checking…' });
/** Gemini failed or timed out: the guess stays, and the status says so. */
const showGuessOnly = () => renderSteps(['done', 'done', 'warn', 'done'], { ai: 'Using a quick guess' });

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

    if (!example && aiPlan().kind === 'gemini') {
      // Gemini takes 3-15 s (up to 20 s when busy): ask it, and meanwhile run the shape-based guess (~0.2 s) so the
      // drawing moves right away. The answer replaces the guess when it reads the drawing differently (see refine).
      const pending = askGemini(annotated, vision.contours);
      const guess = offlineAnalysis(annotated, vision.contours);
      console.log(`[ai] quick guess ${guess.diagram} in ${Math.round(performance.now() - t1)}ms, waiting for Gemini`);
      current = { ...vision, analysis: guess };
      const scene = buildScene(current);
      const guessKey = sceneKey(scene);
      await startScene(current, { scene });
      showControls(scene, guess);
      showGuessing();
      explain.textContent = scene.label;
      void refine(my, pending, t1, guessKey, { ...guess.params });
      return;
    }

    const analysis = example
      ? await cachedAnalysis(example, vision.contours).catch((err) => {
          console.warn(err);
          return offlineAnalysis(annotated, vision.contours);
        })
      : await analyze(annotated, vision.contours);
    if (stale()) return;
    console.log(`[ai] ${analysis.source} ${Math.round(performance.now() - t1)}ms`, analysis);
    if (import.meta.env.DEV) (window as any).__wa.last = { analysis: structuredClone(analysis), fingerprint: fingerprint(vision.contours, analysis) };

    setStep('run');
    await nextFrame();
    if (stale()) return;
    current = { ...vision, analysis };
    const scene = await startScene(current, { intro: true, forGen: my });
    if (!scene) return;
    showControls(scene, analysis);
    setStep('done');
    explain.textContent = analysis.explanation || `${scene.label}${analysis.source === 'heuristic' && !hasApiKey() ? ' (offline mode)' : ''}`;
  } catch (err) {
    console.error(err);
    if (!stale()) setStep('error', 'Something went wrong. Try another photo!');
  } finally {
    if (!stale()) busy = false;
  }
}

/**
 * Gemini's answer for photo `my` arrived (or failed). If it reads the drawing differently from the quick guess
 * (diagram, roles that change the scene, handwritten values), the scene is rebuilt and swapped in under the
 * "what the AI saw" intro; if it would build the very same scene, the motion carries on and only the labels change.
 */
async function refine(my: number, pending: Promise<Analysis | null>, t1: number, guessKey: string, guessParams: SimParams) {
  const ai = await pending.catch(() => null);
  if (my !== gen || !current) {
    console.log('[ai] answer for an older photo, ignored');
    mark('ai-stale', my);
    return;
  }
  const input = current;
  if (!ai) {
    console.log(`[ai] no answer after ${Math.round(performance.now() - t1)}ms, keeping the quick guess`);
    mark('ai-failed');
    showGuessOnly();
    return;
  }
  console.log(`[ai] gemini ${Math.round(performance.now() - t1)}ms`, ai);
  if (import.meta.env.DEV) (window as any).__wa.last = { analysis: structuredClone(ai), fingerprint: fingerprint(input.contours, ai) };
  // Keep what the user changed while the guess was running (slider, voice, Moon).
  const changed = Object.fromEntries(Object.entries(input.analysis.params).filter(([k, v]) => guessParams[k] !== v));
  ai.params = { ...ai.params, ...changed };
  const next: SceneInput = { ...input, analysis: ai };
  const scene = buildScene(next);
  const same = ai.diagram === input.analysis.diagram && !ai.annotations?.length && sceneKey(scene) === guessKey;
  setStep('done');
  explain.textContent = ai.explanation || scene.label;
  if (same) {
    mark('ai-same');
    Object.assign(input.analysis, { ...ai, params: input.analysis.params });
    void overlay.playIntro({ ...input, scene });
  } else {
    mark('ai-rebuild');
    current = next;
    const started = await startScene(next, { intro: true, scene, forGen: my, crossfade: true });
    if (started) showControls(started, ai);
  }
}

/** What a freshly built scene is made of (shapes, joints, cut-outs, scale): equal keys = the same simulation. */
function sceneKey(scene: BuiltScene): string {
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 2) / 2 : String(v));
  const pt = (p?: { x: number; y: number } | null) => (p ? `${r(p.x)},${r(p.y)}` : '-');
  const index = new Map(scene.bodies.map((b, i) => [b, i]));
  const ref = (b?: Matter.Body | null) => (b ? index.get(b) ?? 'x' : -1);
  return JSON.stringify({
    label: scene.label,
    bodies: scene.bodies.map((b) => [b.isStatic, r(b.mass), b.vertices.map(pt).join(' ')]),
    constraints: scene.constraints.map((c) => [ref(c.bodyA), ref(c.bodyB), pt(c.pointA), pt(c.pointB), r(c.length), c.stiffness, c.damping]),
    sprites: scene.sprites.map((sp) => [sp.follow.kind, pt(sp.offset), sp.image.width, sp.image.height]),
    measures: scene.measures,
    physics: scene.physics,
    scale: scene.scale ? [scene.scale.pxPerMeter, scene.scale.timeFactor] : null,
    gravityScale: scene.gravityScale,
  });
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
