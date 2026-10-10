// Air resistance: quadratic drag F = −c·|v|·v with c = ½·ρ·Cd·A (a ball in still air).
//
// With real air a 1 kg ball the size of a drawn circle barely notices it (drag is ~0.03 % of its weight at a few m/s),
// so the switch multiplies real air by a round factor ×N (1, 2, 5, 10, 20, 50, …) picked per drawing so the effect
// is clearly visible, and the switch says so ("Exaggerated ×N"). params.airDrag holds that factor: 0 = off,
// 1 = real air, N = N times real air. Scenes read it every step, so the switch applies at once.

/** Sea-level air, kg/m³. */
export const AIR_DENSITY = 1.2;
/** Drag coefficient of a sphere. */
export const SPHERE_CD = 0.47;

/** c = ½·ρ·Cd·A in kg/m for a ball of radius `r` metres (F = c·v² newtons at v m/s). */
export const dragConstant = (r: number) => 0.5 * AIR_DENSITY * SPHERE_CD * Math.PI * r * r;

/** The 1-2-5 step nearest (in log terms) to `x`, at least 1 (never weaker than real air). */
export function roundFactor(x: number): number {
  if (!(x > 1)) return 1;
  const e = Math.floor(Math.log10(x));
  let best = 1;
  for (const m of [1, 2, 5, 10]) {
    const v = m * 10 ** e;
    if (Math.abs(Math.log(v / x)) < Math.abs(Math.log(best / x))) best = v;
  }
  return Math.min(1e7, best);
}

/** Text under the switch. */
export const airSubtitle = (factor: number) =>
  factor <= 1 ? 'Real air: 1.2 kg/m³, Cd 0.47' : `Real air ×${factor.toLocaleString('en-US')} so you can see it`;
