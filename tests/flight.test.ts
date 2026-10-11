// Projectile flight (src/flight.ts): the range / highest point / flight time read off a Matter.js ball match the
// textbook formulas, on Earth and the Moon, from the ground and from 5 m up, at 15°, 45° and 75°, at two speeds.
// The ball is set up exactly as scenes/projectile.ts sets it up (circle, no air friction, a floor under it,
// steppedLaunch, the meter fed after every engine step). Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Matter from 'matter-js';
import { defaultRange, FlightMeter, flightTheory, landingFraction, steppedLaunch, type FlightTrack } from '../src/flight.ts';
import { parseVoice, type VoiceContext } from '../src/voice.ts';
import { BASE_SCALE, EARTH_G, STEP_ACCEL, STEP_MS, STEP_S, mps, pxPerStep, scaleFor } from '../src/units.ts';

const MOON_G = 1.62;
/** A 960 × 720 photo of a 1 m paper (the app's default scale). */
const SCALE = scaleFor({ width: 960, height: 720, analysis: {} });

/** Fire a ball at v m/s, elev degrees, h metres above the floor, gravity g m/s²; the meter's reading in metres / seconds. */
function fly(v: number, elev: number, h: number, g: number) {
  const ppm = SCALE.pxPerMeter;
  const engine = Matter.Engine.create();
  engine.gravity.y = 1;
  engine.gravity.scale = (BASE_SCALE * g) / EARTH_G;
  const gStep = (STEP_ACCEL * g) / EARTH_G;
  const r = 12;
  const floorY = 100 + h * ppm + r;
  const start = { x: 100, y: floorY - r - h * ppm };
  const floor = Matter.Bodies.rectangle(0, floorY + 50, 1e7, 100, { isStatic: true, friction: 0.9 });
  const ball = Matter.Bodies.circle(start.x, start.y, r, { friction: 0.9, frictionAir: 0, restitution: 0.15, density: 0.002 });
  Matter.Composite.add(engine.world, [floor, ball]);
  const speed = pxPerStep(v, SCALE);
  const th = (elev * Math.PI) / 180;
  const vSet = steppedLaunch({ x: Math.cos(th) * speed, y: -Math.sin(th) * speed }, gStep);
  Matter.Body.setVelocity(ball, vSet);
  const meter = new FlightMeter();
  meter.launch(start, vSet, gStep);
  let track: FlightTrack | null = null;
  for (let i = 0; i < 200000 && !track; i++) {
    Matter.Engine.update(engine, STEP_MS);
    track = meter.step(ball.position, ball.velocity, engine.gravity.y * engine.gravity.scale * STEP_MS * STEP_MS, () => floorY - r);
  }
  assert.ok(track, 'the ball came down');
  // The scene's own conversions: engine speed -> m/s must give back v.
  assert.ok(Math.abs(mps(speed, SCALE) - v) < 1e-9);
  return {
    range: track!.range / ppm,
    maxHeight: track!.rise / ppm,
    time: track!.steps * STEP_S * SCALE.timeFactor,
  };
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));

test('range, highest point and flight time: measured within 2 % of theory (Earth / Moon, 0 m / 5 m, 15° / 45° / 75°, two speeds)', () => {
  const rows: string[] = [];
  let worst = 0;
  for (const g of [EARTH_G, MOON_G])
    for (const h of [0, 5])
      for (const v of [2, 6])
        for (const elev of [15, 45, 75]) {
          const m = fly(v, elev, h, g);
          const t = flightTheory(v, elev, h, g)!;
          const e = { range: rel(m.range, t.range), top: rel(m.maxHeight, t.maxHeight), time: rel(m.time, t.time) };
          worst = Math.max(worst, e.range, e.top, e.time);
          rows.push(
            `g=${g} h=${h} v=${v} θ=${elev}: R ${m.range.toFixed(4)}/${t.range.toFixed(4)} (${(e.range * 100).toFixed(3)}%)` +
              ` top ${m.maxHeight.toFixed(4)}/${t.maxHeight.toFixed(4)} T ${m.time.toFixed(4)}/${t.time.toFixed(4)}`,
          );
          assert.ok(e.range < 0.02, `range off by ${(e.range * 100).toFixed(2)} %: ${rows.at(-1)}`);
          assert.ok(e.time < 0.02, `time off by ${(e.time * 100).toFixed(2)} %: ${rows.at(-1)}`);
          assert.ok(e.top < 0.02, `top off by ${(e.top * 100).toFixed(2)} %: ${rows.at(-1)}`);
        }
  if (process.env.FLIGHT_TABLE) console.log(rows.join('\n'), `\nworst ${(worst * 100).toFixed(3)} %`);
});

test('theory: the textbook cases', () => {
  // From the ground: R = v² sin 2θ / g, top v² sin²θ / 2g, T = 2 v sinθ / g.
  const t = flightTheory(10, 45, 0, 9.8)!;
  assert.ok(Math.abs(t.range - 100 / 9.8) < 1e-9);
  assert.ok(Math.abs(t.maxHeight - 25 / 9.8) < 1e-9);
  assert.ok(Math.abs(t.time - (2 * 10 * Math.SQRT1_2) / 9.8) < 1e-9);
  // Level shot off a 5 m cliff: T = √(2h/g), R = v T.
  const c = flightTheory(3, 0, 5, 9.8)!;
  assert.ok(Math.abs(c.time - Math.sqrt(10 / 9.8)) < 1e-9 && Math.abs(c.range - 3 * Math.sqrt(10 / 9.8)) < 1e-9 && c.maxHeight === 5);
  // Same shot on the Moon goes √(9.8/1.62) times as far.
  assert.ok(Math.abs(flightTheory(3, 0, 5, 1.62)!.range / c.range - Math.sqrt(9.8 / 1.62)) < 1e-9);
  assert.equal(flightTheory(3, 30, 0, 0), null);
});

test('landing fraction: found from the step start even when the floor pushes the ball back in that step', () => {
  // Falling at 10 px per step from 5 px above the landing level, g = 0: half a step.
  assert.ok(Math.abs(landingFraction({ x: 0, y: 95 }, { x: 1, y: 10 }, 0, 100)! - 0.5) < 1e-12);
  // Still above after the step: not yet. Already below: not again.
  assert.equal(landingFraction({ x: 0, y: 80 }, { x: 1, y: 10 }, 0.2, 100), null);
  assert.equal(landingFraction({ x: 0, y: 101 }, { x: 1, y: 10 }, 0.2, 100), null);
});

test('voice on a projectile: ball mass, launch height ("make it higher"), launch angle ("aim higher")', () => {
  const ctx: VoiceContext = {
    targets: [
      { key: 'gravity', value: 9.8, min: 0, max: 25 },
      { key: 'launchSpeed', value: 3, min: 0.1, max: 100 },
      { key: 'launchAngle', value: 40, min: 0, max: 89 },
      { key: 'launchHeight', value: 0, min: 0, max: 50 },
      { key: 'projectileMass', value: 1, min: 0.1, max: 20 },
      { key: 'groundLength', value: 1, min: 0.01, max: 1000 },
    ],
    air: true,
    numbers: true,
  };
  const said = (u: string) => parseVoice(u, ctx).set;
  assert.deepEqual(said('ball mass 2 kilograms'), { projectileMass: 2 });
  assert.deepEqual(said('make it heavier'), { projectileMass: 2 });
  assert.deepEqual(said('launch height 5 meters'), { launchHeight: 5 });
  assert.deepEqual(said('fire from a 3 meter cliff'), { launchHeight: 3 });
  assert.deepEqual(said('make it higher'), { launchHeight: 1 });
  assert.deepEqual(said('angle 45 degrees'), { launchAngle: 45 });
  assert.deepEqual(said('launch angle 30 degrees'), { launchAngle: 30 });
  assert.deepEqual(said('aim higher'), { launchAngle: 50 });
  assert.deepEqual(said('aim lower'), { launchAngle: 30 });
  assert.deepEqual(said('launch at 10 meters per second'), { launchSpeed: 10 });
  assert.deepEqual(said('launch height 2 meters and angle 60 degrees'), { launchHeight: 2, launchAngle: 60 });
  // From 4 m: higher is 6 m, lower 2.67 m.
  const at4 = { ...ctx, targets: ctx.targets.map((t) => (t.key === 'launchHeight' ? { ...t, value: 4 } : t)) };
  assert.deepEqual(parseVoice('make it higher', at4).set, { launchHeight: 6 });
  assert.deepEqual(parseVoice('lower', at4).set, { launchHeight: 2.67 });
  // On an incline the same words still mean the ramp.
  const ramp: VoiceContext = {
    targets: [
      { key: 'gravity', value: 9.8, min: 0, max: 25 },
      { key: 'rampAngle', value: 30, min: 5, max: 75 },
      { key: 'blockMass', value: 1, min: 0.001, max: 1000 },
    ],
    air: false,
    numbers: true,
  };
  assert.deepEqual(parseVoice('angle 45 degrees', ramp).set, { rampAngle: 45 });
  assert.deepEqual(parseVoice('ball mass 2 kilograms', ramp).set, { blockMass: 2 });
});

test('default range: a plain flight down on the drawn ground (60-80 % of it), not a drop', () => {
  const ground = { x0: 50, x1: 950 }; // 900 px of ground on a 1000 px picture, ball radius 10
  // Cannon at the back end: 70 % of the ground, landing 76 % of the way along it.
  const back = defaultRange(100, 1, 10, 1000, ground);
  assert.equal(back, 630);
  assert.ok((100 + back - 50) / 900 >= 0.6 && (100 + back - 50) / 900 <= 0.8);
  // Cannon in the middle: still a long shot, but down before the ground's end (past it is often the paper's edge).
  const mid = defaultRange(500, 1, 10, 1000, ground);
  assert.ok(mid > 0.4 * 900 && 500 + mid < 950, `${mid}`);
  // Mirror image: the same distances to the left.
  assert.equal(defaultRange(900, -1, 10, 1000, ground), back);
  assert.equal(defaultRange(500, -1, 10, 1000, ground), mid);
  // Cannon at the far end: 60 % of the ground at least (the view zooms out), never a hop.
  assert.equal(defaultRange(800, 1, 10, 1000, ground), 540);
  // No ground (or a stub under the cannon): 70 % of the way to the picture's edge.
  assert.equal(defaultRange(100, 1, 10, 1000, null), 0.7 * 890);
  assert.equal(defaultRange(100, 1, 10, 1000, { x0: 60, x1: 200 }), 0.7 * 890);
  // A ball at the picture's edge still flies 4 radii.
  assert.equal(defaultRange(995, 1, 10, 1000, null), 40);
});
