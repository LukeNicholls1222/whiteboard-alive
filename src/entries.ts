// "Your numbers": the lengths, masses, angles and speeds the user types in for the drawing on screen.
// The AI only says what the drawing is and which stroke is which part; every number comes from here (or is assumed).
// Entered values travel as analysis.annotations (from = 'input') and the scenes read them with noteFor (units.ts),
// exactly where they used to read handwritten notes. The launch speed is also params.speed, shared with its slider.

import type { Analysis, Annotation, BuiltScene, PartName, Quantity } from './types';
import { DEFAULT_KG, meters, scaleOf } from './units';

export type EntryKey =
  | 'stringLength'
  | 'bobMass'
  | 'springMass'
  | 'springK'
  | 'blockMass'
  | 'rampAngle'
  | 'launchSpeed'
  | 'launchAngle'
  | 'launchHeight'
  | 'projectileMass'
  | 'groundLength'
  | 'leftMass'
  | 'rightMass'
  | 'leftBallMass'
  | 'rightBallMass'
  | 'leftSpeed'
  | 'rightSpeed'
  | 'leftDistance'
  | 'rightDistance';

/** What the user entered, in the field's unit. A missing key = empty field (the scene assumes a value). */
export type Entries = Partial<Record<EntryKey, number>>;

export interface EntrySpec {
  key: EntryKey;
  label: string;
  unit: string;
  quantity: Quantity;
  part: PartName;
  /** Accepted range (inclusive); anything else is refused with a red border. */
  min: number;
  max: number;
}

const spec = (key: EntryKey, label: string, unit: string, quantity: Quantity, part: PartName, min: number, max: number): EntrySpec => ({
  key,
  label,
  unit,
  quantity,
  part,
  min,
  max,
});

export const ENTRY_SPECS: Record<EntryKey, EntrySpec> = {
  stringLength: spec('stringLength', 'String length', 'm', 'length', 'string', 0.01, 100),
  bobMass: spec('bobMass', 'Bob mass', 'kg', 'mass', 'bob', 0.001, 1000),
  springMass: spec('springMass', 'Mass', 'kg', 'mass', 'block', 0.001, 1000),
  springK: spec('springK', 'Spring constant', 'N/m', 'spring_constant', 'spring', 0.1, 100000),
  blockMass: spec('blockMass', 'Block mass', 'kg', 'mass', 'block', 0.001, 1000),
  rampAngle: spec('rampAngle', 'Angle', '°', 'angle', 'ramp', 5, 75),
  launchSpeed: spec('launchSpeed', 'Launch speed', 'm/s', 'speed', 'arrow', 0.1, 100),
  // Elevation above level, towards the side the drawing fires to (the fitted speed stays the drawing's).
  launchAngle: spec('launchAngle', 'Launch angle', '°', 'angle', 'launcher', 0, 89),
  // Launch point above the ground, same scale: the launcher moves up onto a platform (or down), scenes/projectile.ts.
  launchHeight: spec('launchHeight', 'Launch height', 'm', 'length', 'launcher', 0, 50),
  // The ball's mass: the path is the same without air; with air a heavier ball is slowed less (and the energy grows).
  projectileMass: spec('projectileMass', 'Ball mass', 'kg', 'mass', 'ball', 0.1, 20),
  groundLength: spec('groundLength', 'Ground length', 'm', 'length', 'ground', 0.01, 1000),
  leftMass: spec('leftMass', 'Left mass', 'kg', 'mass', 'left weight', 0.001, 1000),
  rightMass: spec('rightMass', 'Right mass', 'kg', 'mass', 'right weight', 0.001, 1000),
  leftBallMass: spec('leftBallMass', 'Left mass', 'kg', 'mass', 'left ball', 0.001, 1000),
  rightBallMass: spec('rightBallMass', 'Right mass', 'kg', 'mass', 'right ball', 0.001, 1000),
  // Signed: right = +, left = −, 0 = the ball waits.
  leftSpeed: spec('leftSpeed', 'Left speed', 'm/s', 'speed', 'left ball', -100, 100),
  rightSpeed: spec('rightSpeed', 'Right speed', 'm/s', 'speed', 'right ball', -100, 100),
  leftDistance: spec('leftDistance', 'Left distance', 'm', 'length', 'left weight', 0.001, 1000),
  rightDistance: spec('rightDistance', 'Right distance', 'm', 'length', 'right weight', 0.001, 1000),
};

/** One input box as shown for a built scene. */
export interface EntryField extends EntrySpec {
  /** Shown while empty: the value the scene uses, number only ("0.43", "31"); the unit sits next to the box. */
  placeholder: string;
  /** Set when this drawing cannot take the whole range (a ramp stretched taller than the picture): the real maximum. */
  fitMax?: number;
  /** The same for the low end (a seesaw weight cannot slide past the pivot): the real minimum. */
  fitMin?: number;
  /** Value to show in the box while nothing is entered (the launch speed mirrors its slider). */
  mirror?: number;
  /** Only in "Your numbers" (and voice), not as a pill under the picture (the launch's Ground: the drawing's scale). */
  noPill?: boolean;
}

const sig = (v: number) => String(Number(v.toPrecision(3)));
/** A placeholder: the number only. Where the value came from (assumed, drawn...) is never shown. */
const said = (v: number) => sig(v);

/** The boxes for the scene on screen (none for the falling-objects fallback), placeholders from the scene itself. */
export function fieldsFor(scene: BuiltScene, analysis: Pick<Analysis, 'params'>): EntryField[] {
  const s = scaleOf(scene);
  const parts = scene.parts ?? {};
  const measures = scene.measures ?? {};
  const out: EntryField[] = [];
  const add = (key: EntryKey, placeholder: string, extra: Partial<EntryField> = {}) =>
    out.push({ ...ENTRY_SPECS[key], placeholder, ...extra });
  const kg = (part: PartName) => parts[part]?.kg ?? DEFAULT_KG;
  const length = (part: PartName) => {
    const px = measures[part];
    return px ? said(meters(px, s)) : '';
  };

  switch (scene.label) {
    case 'Pendulum':
      if (measures.string) add('stringLength', length('string'));
      if (parts.bob) add('bobMass', said(kg('bob')));
      break;
    case 'Spring and mass': {
      if (parts.block) add('springMass', said(kg('block')));
      const k = scene.physics?.springK?.value;
      if (k && parts.block) add('springK', said(k));
      break;
    }
    case 'Incline': {
      // A ball on the slope rolls (scenes/roll.ts): same entry, named for what was drawn.
      if (parts.block) add('blockMass', said(kg('block')), scene.physics?.rolling ? { label: 'Ball mass' } : {});
      const used = scene.physics?.rampAngleUsed;
      const drawn = scene.physics?.rampAngle;
      if (drawn !== undefined) {
        const max = used?.max ?? ENTRY_SPECS.rampAngle.max;
        add('rampAngle', said(Math.round(drawn)), max < ENTRY_SPECS.rampAngle.max ? { fitMax: max } : {});
      }
      break;
    }
    case 'Projectile': {
      const ls = scene.physics?.launchSpeed;
      if (ls) {
        const speed = analysis.params.speed;
        add('launchSpeed', said(ls.fit), typeof speed === 'number' && speed > 0 ? { mirror: speed } : {});
      }
      const launch = scene.physics?.launch;
      if (launch) {
        add('launchAngle', said(Math.round(launch.drawnAngleDeg)));
        // 0 for a shot from the ground.
        add('launchHeight', said(launch.heightDrawnM));
      }
      if (parts.ball) add('projectileMass', said(kg('ball')));
      // The scale of the whole drawing, not a setting of the shot: kept out of the pills under the picture.
      if (measures.ground) add('groundLength', length('ground'), { noPill: true });
      break;
    }
    case 'Pulley':
      if (parts['left weight']) add('leftMass', said(kg('left weight')));
      if (parts['right weight']) add('rightMass', said(kg('right weight')));
      break;
    case 'Collision': {
      if (parts['left ball']) add('leftBallMass', said(kg('left ball')));
      if (parts['right ball']) add('rightBallMass', said(kg('right ball')));
      const v = scene.physics?.ballSpeeds;
      // The speed the drawing gives (its arrow, or the push when nothing was drawn); a typed one shows in the box itself.
      if (v && parts['left ball']) add('leftSpeed', said(v.left.drawn));
      if (v && parts['right ball']) add('rightSpeed', said(v.right.drawn));
      break;
    }
    case 'Seesaw': {
      // Masses and distances from the pivot (the weight slides along the plank to an entered distance).
      if (parts['left weight']) add('leftMass', said(kg('left weight')));
      if (parts['right weight']) add('rightMass', said(kg('right weight')));
      // As far as the weight can slide on the plank while the other one stays (scenes/lever.ts).
      const lever = scene.physics?.lever;
      const fit = (key: EntryKey, side: { dMin?: number; dMax?: number } | null | undefined): Partial<EntryField> => {
        const out: Partial<EntryField> = {};
        if (side?.dMax !== undefined && side.dMax < ENTRY_SPECS[key].max) out.fitMax = side.dMax;
        if (side?.dMin !== undefined && side.dMin > ENTRY_SPECS[key].min) out.fitMin = Math.min(side.dMin, side.dMax ?? Infinity);
        return out;
      };
      if (parts['left weight']) add('leftDistance', length('left weight'), fit('leftDistance', lever?.left));
      if (parts['right weight']) add('rightDistance', length('right weight'), fit('rightDistance', lever?.right));
      break;
    }
  }
  return out;
}

/**
 * Left / right values a scene reads as a pair: with only one of them entered, the scene works the other out from the
 * drawing *relative to the entered one* (the pulley and seesaw keep the drawn mass ratio; a seesaw distance sets the
 * scale), so changing one side would change the other too. The collision's balls are each read on their own.
 */
const PARTNER: Partial<Record<EntryKey, EntryKey>> = {
  leftMass: 'rightMass',
  rightMass: 'leftMass',
  leftDistance: 'rightDistance',
  rightDistance: 'leftDistance',
};

/**
 * `entries` with `key` set to `v`. When `key` has a partner that is still empty, the partner is entered too, at the
 * value it shows now (`shown`), so it stays exactly as it is. The partner always goes first and `key` last: the
 * seesaw distance left alone is the one that sets the scale (it stays where it was drawn) and the changed weight is
 * the one that slides (scenes/lever.ts, which also gives the range it can slide in).
 */
export function enterPair(entries: Entries, key: EntryKey, v: number, shown: (k: EntryKey) => number | undefined): Entries {
  const partner = PARTNER[key];
  const keep = partner === undefined ? undefined : entries[partner] ?? shown(partner);
  if (partner === undefined || keep === undefined || !(keep >= ENTRY_SPECS[partner].min && keep <= ENTRY_SPECS[partner].max))
    return { ...entries, [key]: v };
  const rest: Entries = { ...entries };
  delete rest[partner];
  delete rest[key];
  return { [partner]: keep, ...rest, [key]: v };
}

/** The partner `enterPair` would fill in for `key` (for the boxes on screen). */
export const partnerOf = (key: EntryKey): EntryKey | undefined => PARTNER[key];

/** Entered values as the annotations the scenes read (noteFor). */
export function annotationsFrom(entries: Entries): Annotation[] {
  const out: Annotation[] = [];
  for (const [key, value] of Object.entries(entries) as [EntryKey, number | undefined][]) {
    const s = ENTRY_SPECS[key];
    if (!s || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out.push({ text: `${sig(value)} ${s.unit}`, quantity: s.quantity, value, unit: s.unit, part: s.part, from: 'input' });
  }
  return out;
}
