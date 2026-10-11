# Physics audit (2026-10-11, 14:50 PDT)

Read-only audit of every scene's formulas, unit conversions and on-screen numbers. No code was changed. Tests 123/123.

## Result: no calculation errors

| Scene | Verdict | How it was checked |
|---|---|---|
| Pendulum | Correct | RK4 on θ'' = −(g/L) sin θ (pendulum.ts:106). Finite-amplitude theory uses the exact 1/AGM(1, cos(θ₀/2)) (graph.ts:793). With θ₀ = 20°: L = 1 / 0.25 / 2.2 m → 2.0225 / 1.0112 / 2.9998 s, matching the screen (2.02 / 1.01 / 3.00). PE zero is the lowest point. |
| Spring | Correct | ω² = k/m, u_eq = mg/k, exact solution each step (spring-motion.ts:93). Energy drift 1e-12. 0.889 / 0.341 / 0.483 / 2.995 s match. |
| Ramp (block) | Correct | Coulomb step |Δv_t| ≤ μ g cos θ (incline.ts:67): g(sin θ − μ cos θ), stops when tan θ ≤ μ (same μ for static and kinetic). |
| Rolling ball | Correct | Rolls when μ ≥ (2/7) tan θ, a = 5/7 g sin θ; slides otherwise at g(sin θ − μ cos θ) (roll.ts:158). 4.32 and 4.35 m/s² reproduced. |
| Projectile | Correct | R, T, max height with launch height h (flight.ts:18), half-step correction and landing interpolation. 2 m/s 75° h 0.30: 0.266 / 0.490 / 0.513. Moon 5 m/s 45°: 17.08 / 5.68 / 4.83. Default: 52.4 / 27.8 / 3.00. Air drag F = c v², deceleration c v²/m (heavier flies farther): 0.137 / 0.242 m reproduced. |
| Pulley | Correct | a = g(mL − mR)/(mL + mR) (pulley.ts:605). Equal masses: a = 0, constant speed. |
| Collision | Correct | 1-D restitution formulas (collision-physics.ts:37). Momentum kept in ball-ball hits, KE kept at e = 1, e = 0 sticks. |
| Seesaw | Formula correct | Torque m·g·d (graph.ts:478). |
| Units | Correct | px ↔ m, steps ↔ s, timeFactor, springK. Presets: Moon 1.62, Mars 3.71, Jupiter 24.8 (real 24.79). |
| Display | Correct | J, N·m, kg·m/s, m/s², N/m. |

## Could mislead (not physics errors)

1. **Pendulum theory label** (graph.ts:232): shows "Theory (θ₀=20°) = 2.02 s" with no formula. Hand-computing 2π√(L/g) gives 2.007. The value is right (finite-amplitude factor ×1.0077).
2. **Seesaw "Nearly balanced" threshold** (lever-plan.ts:544, 554-555): the comment says 12 % of the larger moment, the code uses |τR − τL| / (τL + τR) ≤ 0.12, which allows about 21 % of the larger one. Only when some value comes from the drawing. All-typed 0.1 % is also of the sum (about 0.2 % of the larger).
3. **Seesaw d rounding** (notes.ts:671): d is shown to 2 decimals, so m·g·d from the labels is off by 0.5–0.7 % from the shown torque (computed from the unrounded d).
4. **Collision "Total p"**: kept through ball-ball hits, but wall bounces change it (the wall is an external force). Say "conserved in the collision between the balls".

## Notes (not verified on screen)

- Collision masses from the drawing scale with radius² (area), not radius³. Typed values are used as given.
- The seesaw plank's own weight is not in the torque (textbook "massless plank").
- The pulley integrates with forward Euler, under 0.5 % travel error; no theory value is shown for it.
