import './style.css';
import { analyze, hasApiKey } from './ai';
import { buildScene } from './scenes';
import { Simulation } from './sim';
import { annotate, extractContours, loadOpenCV, toWorkingCanvas } from './vision';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('file');
const status = $<HTMLDivElement>('status');
const stage = $<HTMLCanvasElement>('stage');
const explain = $<HTMLParagraphElement>('explain');

let sim: Simulation | null = null;

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
    const scene = buildScene({ ...vision, analysis });
    sim?.stop();
    sim = new Simulation(stage, scene, vision.width, vision.height);
    sim.setParams(analysis.params);
    sim.start();
    setStep('done');
    explain.textContent = analysis.explanation || `${scene.label}${analysis.source === 'heuristic' && !hasApiKey() ? ' (offline mode)' : ''}`;
  } catch (err) {
    console.error(err);
    setStep('error', 'Something went wrong. Try another photo!');
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
