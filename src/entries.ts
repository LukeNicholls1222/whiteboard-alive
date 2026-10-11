// "Your numbers": the lengths, masses, angles and speeds the user types in for the drawing on screen.
// The AI only says what the drawing is and which stroke is which part; every number comes from here (or is assumed).
// Entered values travel as analysis.annotations (from = 'input') and the scenes read them with noteFor (units.ts),
// exactly where they used to read handwritten notes. The launch speed is also params.speed, shared with its slider.

import type { Analysis, Annotation, BuiltScene, PartName, Quantity, ValueSource } from './types';
import { DEFAULT_KG, SOURCE_TEXT, meters, scaleOf, springK } from './units';

export type EntryKey =
  | 'stringLength'
  | 'bobMass'
  | 'springMass'
  | 'springK'
  | 'blockMass'
  | 'rampAngle'
  | 'launchSpeed'
  | 'groundLength'
  | 'leftMass'
  | 'rightMass';

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
  groundLength: spec('groundLength', 'Ground length', 'm', 'length', 'ground', 0.01, 1000),
  leftMass: spec('leftMass', 'Left mass', 'kg', 'mass', 'left weight', 0.001, 1000),
  rightMass: spec('rightMass', 'Right mass', 'kg', 'mass', 'right weight', 0.001, 1000),
};

/** One input box as shown for a built scene. */
export interface EntryField extends EntrySpec {
  /** Shown while empty, e.g. "0.43 assumed" or "31° drawn". */
  placeholder: string;
  /** Set when this drawing cannot take the whole range (a ramp stretched taller than the picture): the real maximum. */
  fitMax?: number;
  /** Value to show in the box while nothing is entered (the launch speed mirrors its slider). */
  mirror?: number;
}

const sig = (v: number) => String(Number(v.toPrecision(3)));
const said = (v: number, from: ValueSource = 'assumed', unit = '') => `${sig(v)}${unit} ${SOURCE_TEXT[from]}`;

/** The boxes for the scene on screen (none for the falling-objects fallback), placeholders from the scene itself. */
export function fieldsFor(scene: BuiltScene, analysis: Pick<Analysis, 'params'>): EntryField[] {
  const s = scaleOf(scene);
  const parts = scene.parts ?? {};
  const measures = scene.measures ?? {};
  const out: EntryField[] = [];
  const add = (key: EntryKey, placeholder: string, extra: Partial<EntryField> = {}) =>
    out.push({ ...ENTRY_SPECS[key], placeholder, ...extra });
  const kg = (part: PartName) => parts[part]?.kg ?? DEFAULT_KG;
  const kgFrom = (part: PartName) => (parts[part]?.kgFrom === 'input' ? 'assumed' : parts[part]?.kgFrom ?? 'assumed');
  const length = (part: PartName) => {
    const px = measures[part];
    // "to scale" when another entered length set the scale.
    return px ? said(meters(px, s), s.note && s.note.part !== part ? 'scaled' : 'assumed') : '';
  };

  switch (scene.label) {
    case 'Pendulum':
      if (measures.string) add('stringLength', length('string'));
      if (parts.bob) add('bobMass', said(kg('bob'), kgFrom('bob')));
      break;
    case 'Spring and mass': {
      if (parts.block) add('springMass', said(kg('block'), kgFrom('block')));
      const c = scene.constraints[0];
      if (c && parts.block) {
        const from = scene.physics?.springK?.from;
        add('springK', said(springK(c.stiffness, kg('block'), s), from === 'adjusted' ? 'adjusted' : 'assumed'));
      }
      break;
    }
    case 'Incline': {
      // A ball on the slope rolls (scenes/roll.ts): same entry, named for what was drawn.
      if (parts.block) add('blockMass', said(kg('block')), scene.physics?.rolling ? { label: 'Ball mass' } : {});
      const used = scene.physics?.rampAngleUsed;
      const drawn = scene.physics?.rampAngle;
      if (drawn !== undefined) {
        const max = used?.max ?? ENTRY_SPECS.rampAngle.max;
        add('rampAngle', said(Math.round(drawn), 'drawn', '°'), max < ENTRY_SPECS.rampAngle.max ? { fitMax: max } : {});
      }
      break;
    }
    case 'Projectile': {
      const ls = scene.physics?.launchSpeed;
      if (ls) {
        const speed = analysis.params.speed;
        add('launchSpeed', said(ls.fit, 'auto'), typeof speed === 'number' && speed > 0 ? { mirror: speed } : {});
      }
      if (measures.ground) add('groundLength', length('ground'));
      break;
    }
    case 'Pulley':
      if (parts['left weight']) add('leftMass', said(kg('left weight'), kgFrom('left weight')));
      if (parts['right weight']) add('rightMass', said(kg('right weight'), kgFrom('right weight')));
      break;
  }
  return out;
}

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
