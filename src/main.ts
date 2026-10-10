import './style.css';
import { analyze, hasApiKey } from './ai';
import { createControls } from './controls';
import { LiveGraph } from './graph';
import { buildScene } from './scenes';
import { AIOverlay } from './overlay';
import { Simulation } from './sim';
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
if (import.meta.env.DEV) (window as any).__wa = { controls, get sim() { return sim; } };

async function startScene(input: SceneInput, intro = false): Promise<BuiltScene> {
  const scene = buildScene(input);
  sim?.stop();
  // Show what the AI understood on top of the paper, then let it come alive.
  if (intro) await overlay.playIntro({ ...input, scene });
  sim = new Simulation(stage, scene, input.width, input.height);
  sim.setParams(input.analysis.params);
  graph.attach(sim, input.analysis.diagram);
  sim.start();
  return scene;
}
const graph = new LiveGraph(stage.parentElement!);

// Start loading OpenCV right away so it is ready by the time a photo is picked.
const cvPromise = loadOpenCV();

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
  if (file) run(file).finally(() => (fileInput.value = ''));
});

// ?src=<image url> runs the pipeline on a hosted image (used for testing with samples/).
const srcParam = new URLSearchParams(location.search).get('src');
if (srcParam) fetch(srcParam).then((r) => r.blob()).then(run);

async function run(file: Blob) {
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
    const analysis = await analyze(annotate(vision.paper, vision.contours), vision.contours);
    console.log(`[ai] ${analysis.source} ${Math.round(performance.now() - t1)}ms`, analysis);

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
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
