import './style.css';
import { analyze, hasApiKey, offlineAnalysis } from './ai';
import { cachedAnalysis, EXAMPLES, exampleBlob, exampleThumb, fingerprint, preloadExamples } from './examples';
import { createControls } from './controls';
import { LiveGraph } from './graph';
import { buildScene } from './scenes';
import { AIOverlay } from './overlay';
import { Simulation } from './sim';
import { VelocityArrows } from './vectors';
import type { BuiltScene, SceneInput } from './types';
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
if (import.meta.env.DEV) (window as any).__wa = { controls, arrows, get sim() { return sim; } };

async function startScene(input: SceneInput, intro = false): Promise<BuiltScene> {
  const scene = buildScene(input);
  sim?.stop();
  // Show what the AI understood on top of the paper, then let it come alive.
  if (intro) await overlay.playIntro({ ...input, scene });
  sim = new Simulation(stage, scene, input.width, input.height);
  // The sim is the single source of truth: any change (incl. the Moon switch) flows back to the
  // stored params (used on rebuild) and to the sliders / chips.
  sim.paramListeners.push((p) => {
    Object.assign(input.analysis.params, p);
    controls.sync(p);
  });
  sim.setParams(input.analysis.params);
  graph.attach(sim, input.analysis.diagram);
  arrows.attach(sim);
  sim.start();
  return scene;
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

function setStep(step: Step | 'done' | 'error', detail = '') {
  const order: Step[] = ['load', 'contours', 'ai', 'run'];
  const idx = step === 'done' ? order.length : order.indexOf(step as Step);
  status.innerHTML = order
    .map((s, i) => `<span class="step ${i < idx ? 'done' : i === idx ? 'active' : ''}">${STEPS[s]}</span>`)
    .join('');
  if (step === 'error') status.innerHTML = `<span class="step error">${detail}</span>`;
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
  busy = true;
  try {
    overlay.reset();
    setStep('load');
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const photo = toWorkingCanvas(bitmap, bitmap.width, bitmap.height);
    const cv = await cvPromise;

    setStep('contours');
    await nextFrame();
    const t0 = performance.now();
    const vision = extractContours(cv, photo);
    console.log(`[vision] ${vision.contours.length} contours in ${Math.round(performance.now() - t0)}ms`, vision.contours);

    setStep('ai');
    const t1 = performance.now();
    const annotated = annotate(vision.paper, vision.contours);
    const analysis = example
      ? await cachedAnalysis(example, vision.contours).catch((err) => {
          console.warn(err);
          return offlineAnalysis(annotated, vision.contours);
        })
      : await analyze(annotated, vision.contours);
    console.log(`[ai] ${analysis.source} ${Math.round(performance.now() - t1)}ms`, analysis);
    if (import.meta.env.DEV) (window as any).__wa.last = { analysis: structuredClone(analysis), fingerprint: fingerprint(vision.contours, analysis) };

    setStep('run');
    await nextFrame();
    current = { ...vision, analysis };
    const scene = await startScene(current, true);
    // buildScene drops to the fallback when the chosen builder fails; show that scene's sliders.
    controls.show(scene.label === 'Falling objects' ? 'fallback' : analysis.diagram, analysis.params);
    setStep('done');
    explain.textContent = analysis.explanation || `${scene.label}${analysis.source === 'heuristic' && !hasApiKey() ? ' (offline mode)' : ''}`;
  } catch (err) {
    console.error(err);
    setStep('error', 'Something went wrong. Try another photo!');
  } finally {
    busy = false;
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
