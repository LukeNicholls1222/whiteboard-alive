# Whiteboard Alive — Devpost draft

> Draft for the OCCHacks 2026 submission (Education track).
> Anything marked `<!-- TODO -->` must be filled in or checked before we submit.
> Rule for this file: only describe what actually works on the live site. Anything still in progress goes under "planned".

**Tagline:** Draw a physics diagram on paper, snap a photo, and watch your drawing transform into a live simulation.

## Short version (paste into "About the project")

Physics teachers draw a pendulum or a block on a ramp and ask the class to "imagine it moving", and simulation apps make students rebuild the problem from menus, so we made the drawing itself the input. Whiteboard Alive is a web app: you draw a pendulum, spring, ramp (with a block or a rolling ball), projectile, pulley, two colliding balls or a seesaw on paper and take a photo with your phone, and your drawing transforms into a clean physics simulation in the same place. The app colours each stroke by what it understood, a light traces your drawing part by part, and each part snaps into a clean shape before it starts to move. You can then type in real values such as string length or ramp angle, change gravity (including a Moon switch) or speak commands like "make the string 1 meter", and compare what was measured with the theory: the period against 2π√(L/g), a rolling ball against a = 5/7 g sinθ, total momentum before and after a collision, and the moments m·g·d on a seesaw. OpenCV.js finds and numbers every stroke on the phone, Gemini only labels what each numbered stroke is (string, weight, spring...), and Matter.js runs the physics. All positions come from computer vision rather than the AI. If the AI is unavailable, a guess from the shapes alone still picked the right diagram for all 42 of our test drawings.

---

## Inspiration

Every physics class has the same moment: the teacher draws a pendulum or a block on a ramp on the whiteboard, and then says "now imagine it moving." Half the room can't.

Simulation apps exist, but they make you rebuild the problem with their sliders and their clip-art. We wanted the opposite: start from the drawing you already made, and turn *that* into the simulation. No menus, no re-drawing. The sketch is the input.

<!-- TODO: add a personal line from the team (e.g. a class where this would have helped) -->

## What it does

1. You draw a physics diagram on paper (or a whiteboard).
2. You take a photo with your phone, right in the browser.
3. Whiteboard Alive finds your strokes and works out what each one *is* (a pivot, a string, a weight, a spring...). Nothing moves until it has understood the drawing.
4. Your drawing transforms into a clean simulation:
   - Every stroke is coloured by its role ("this is the string, this is the weight").
   - A light traces your drawing part by part: fixed parts, then links, then masses.
   - Each part snaps into a clean, textbook shape, and the simulation starts.
   - The fixed parts of your drawing stay faintly in the background. The hand-drawn moving parts fade out after a few seconds.

While it runs you can change the physics:

- **Value pills**: right under the moving picture, each value is shown as a small pill with its unit (for example Length 2.2 m, Mass 1 kg). Tap one to get − / +, a slider and a number box, so you can change it while you watch it move, with no scrolling. A ramp has a Friction pill, and a launch has Speed, Angle, Height and Mass pills. A pill, its slider, Your numbers and voice ("rough") all change the same value.
- **Defaults**: with nothing typed in, each scene is sized so one motion takes about 3 seconds at real time with normal gravity: a 2.2 m pendulum (period 3.00 s), a 1 kg mass on a 4.4 N/m spring, a launch that flies 52 m in 3.00 s, two balls that meet after about 3 s. Typed values are used as they are: once you type a value, the paper is taken to be about 1 m across and the scene is rescaled to match.
- **Your numbers**: type in real values. String length, mass, spring constant, ramp angle, launch speed, launch angle (0–89°), launch height (0–50 m), ball mass (0.1–20 kg), ground length, and the left and right masses on a pulley. Sizes come from these numbers, not from the paper.
- **Sliders and presets**: gravity (every diagram), friction (incline), launch speed (projectile), Bounciness e from 0 to 1 (collision: 1 is elastic, 0 sticks), and Earth / Moon / Jupiter. In Moon mode a pendulum visibly slows down.
- **Voice**: tap Talk and say "make the string 1 meter", "make gravity weaker", "angle 45 degrees", "aim higher" or "launch height 5 meters". Voice can change every setting.
- **Slow motion**: tap the badge at the top left of the picture to go 1× → 0.5× → 0.33× → 0.11× and back to 1× ("REAL TIME 1×", "SLOW MOTION 0.11×"). Each physics step keeps the same length, and only the number of steps per frame changes, so the period, speed and energy readouts are the same at every speed. Drawing is interpolated between physics steps, so even 0.11× moves smoothly.
- **Air resistance**: a switch that is honest about the scale. It shows real air, or "real air ×N" when the effect is exaggerated so you can see it. With air off, a heavier ball follows exactly the same path; with air on, it flies farther (at 2 m/s and 75° from a muzzle at h = 0.30 m, 1 kg lands at 0.14 m and 10 kg at 0.24 m, against 0.27 m with no air).
- **Velocity arrows**: arrow length is proportional to speed, with a scale bar.
- **Live graph card**, always theory next to measurement:
  - Pendulum and spring: kinetic and potential energy (potential measured from the lowest point), plus the measured period next to the theory value: 2π√(L/g) for the pendulum and 2π√(m/k) for the spring.
  - Rolling ball: measured acceleration next to a = 5/7 g sinθ.
  - Projectile: Range, Max height and Flight time as "measured · theory", plus a dotted range line on the ground and a "Range = 52 m" card.
  - Collision: momentum of each ball and the total, plus kinetic energy.
  - Seesaw: Torque balance, the moment m·g·d on each side and a verdict (Left wins / Right wins / Balanced! / Nearly balanced).
- **Show what AI saw**: brings the colour-coded overlay back with one tap.

A single progress line shows each step so the screen never looks frozen. If it can't recognise the drawing, it still makes something fall. It never just sits there.

**Diagram types**

| Diagram | Status |
|---|---|
| Pendulum (pivot, string, bob → swings) | Working |
| Spring and mass (zig-zag + box → oscillates) | Working |
| Incline with a block (triangle + box → slides, friction stops it) | Working |
| Incline with a ball (triangle + circle → rolls, a = 5/7 g sinθ) | Working |
| Projectile (cannon or arrow → clean cannon fires a parabola; launch angle, height and ball mass can be set) | Working |
| Pulley (wheel + rope + two weights → heavier one drops; equal masses drift at a steady speed) | Working |
| Collision (floor + two circles + arrows → they hit and bounce, momentum kept) | Working |
| Seesaw / lever (triangle pivot + plank + boxes → tips toward the larger moment) | Working |
| "Anything else" fallback (object + ground → it falls) | Working |

**Works offline too**

- "Or try one of ours": six example drawings with saved AI results. Tapping one runs the full pipeline with zero network calls to the AI.

## How we built it

The whole app is a static web page with no server of our own. It runs in the phone's browser.

**1. Computer vision on the device (OpenCV.js)**
Phone photos are messy, so the image is cleaned up before any contour is extracted. By default only black ink is picked up, so stains, the desk, fold shadows and the edge of the paper don't turn into strokes. If the drawing is in blue pen, the app switches to the general ink detection automatically. Each pixel is compared with a smoothed estimate of the background, so shadows and uneven light cancel out. Lines on ruled or grid paper are erased, breaks in strokes are joined, and specks are filtered out. Then we extract contours and simplify each one with Douglas-Peucker. Every contour gets an id, a bounding box, a centroid, an ink-pixel count, and a flag for whether it's a closed loop.

**2. The AI only labels and never guesses coordinates (Gemini)**
This is the key design choice. We send Gemini two things: the photo with each contour outlined and labelled `#0`, `#1`, ..., and the list of contours with their real pixel data. Gemini returns structured JSON (enforced with a response schema): the diagram type, a role for each contour id (pivot, rope, bob, spring, mass...), and a one-sentence explanation.

Language models are bad at pixel-exact positions but good at "that circle is the weight." So all geometry comes from OpenCV, and the AI only answers *what* each shape is. Sizes and masses come from the numbers the user types in. The answer is sanitised before use: unknown ids are dropped, numbers are clamped, and missing fields get defaults.

**2b. A guess from the shapes alone (no AI)**
The app waits for the AI before anything moves. When Gemini is unavailable (free-tier quota, a slow venue network, no connection), it still has to pick the right scene. The fallback guess works on the ink itself. It finds closed triangles, circles and boxes by how much of their bounding rectangle they fill, picks out filled-in blobs, and finds zig-zag bands where scan lines cross the ink at regular spacing. Adding `?offline` to the URL forces this mode.

We tested it on 42 generated drawings: clean ones, faint pencil, ruled paper, dim light, broken lines, the rolling ball, collision and seesaw, and drawings that match no diagram. With no AI, on the live site, it picked the right diagram for 42 of 42, and 42 of 42 moved.

**3. Physics (Matter.js)**
Each diagram type has its own scene builder that turns roles into rigid bodies and constraints. Stiffness and damping for each constraint are fixed constants per diagram type, chosen by us and not by the AI, so the simulation behaves the same way every time. Matter.js friction at low speeds behaves more like drag, so the incline applies its own Coulomb friction step after every physics update.

Where a textbook formula exists, we compute the motion ourselves so the numbers match it:
- **Spring**: the block moves by the exact solution of u'' = −(k/m)(u − u_eq). Total energy stays flat (0.00% drift), the period is exactly 2π√(m/k), and mass and spring constant are separate values: doubling the mass keeps k and makes the period √2 times longer.
- **Projectile**: a drawn cannon becomes a clean cannon: a grey barrel with a muzzle band and a rear knob, purple wheels, a light carriage and an axle pin. Launch angle, launch height and ball mass are inputs. Changing the angle turns the barrel smoothly around the axle (0.26 s), and the ball leaves exactly from the muzzle along the barrel (0.00 px off, within 0.01°). A small arc at the axle shows the angle. A drawing with only an arrow keeps the arrow, which turns with the angle. Raising the height lifts the cannon on a capped stand; a cannon standing on the ground can't go below it, so the height then shows its muzzle height, such as "h = 0.30 m". With nothing typed in, the ground is 122 m and the launch speed 18.5 m/s, so the ball flies 52 m in 3.00 s. Range, max height and flight time match the theory within 0.083% across Earth and Moon, several heights and speeds, and 15°, 45° and 75°.
- **Rolling ball**: a circle on the slope rolls at a = 5/7 g sinθ (a solid ball) and turns by distance / radius. If friction can't hold it, it slides while turning.
- **Collision**: exact one-dimensional motion from event to event. Momentum is kept through every hit, Bounciness e = 1 keeps the kinetic energy, and e = 0 makes the balls stick.
- **Pulley and seesaw**: each side's mass (and, on a seesaw, distance) is its own value. Changing one side never changes the other. On a pulley with exactly equal masses the acceleration is zero, so it keeps moving at a slow, steady speed, as Newton's first law says.
- **Seesaw**: the plank tips toward the side with the larger moment m·g·d, and the weights ride on it. With only the drawing (no values typed in), drawn sizes within 12% of each other show "Nearly balanced" and the plank tilts only slightly. Once any value is typed in, every value counts as typed, and it shows "Balanced!" only when m₁d₁ = m₂d₂ to within 0.1%.

**4. From hand drawing to clean figure**
Each scene describes its own clean figure. After the colour overlay, a light traces the matching strokes part by part, the clean shape snaps in over them with a ring, and from then on the clean figure is what moves. The fixed parts of the original drawing stay faintly behind it, so you can still see where it came from.

**5. Voice**
The Web Speech API turns speech into text. A keyword parser handles it first, instantly ("make the string 1 meter", "moon", "air on"). Only if nothing matches does Gemini turn the text into a small diff such as `{"set": {"gravity": 1.6}}`.

**6. Hosting**
Vite + TypeScript with a plain Canvas (no framework). GitHub Actions builds on every push to `main` and deploys to GitHub Pages. The Gemini key is injected at build time, is restricted to the Gemini API only, and will be deleted after the event.

## Challenges we ran into

- **Real photos are messy.** Shadows, faint pencil, ruled paper, stains and the desk at the edge of the shot. Picking up black ink only, normalising against the background and joining broken strokes got all 42 of our test drawings moving.
- **Getting the AI to stop inventing coordinates.** Early on it's tempting to ask the model "where is the pivot?" The answers were close but never exact. Giving it numbered contours and only asking for roles fixed this.
- **"Nothing happens" is the worst outcome.** We built the fallback scene first, so even a drawing we don't understand still drops something.
- **Free-tier AI quotas and slow responses.** The app falls through a chain of Flash models. The first one gets 9 seconds and the whole chain is capped at 20. If all of them fail, the shape-based guess still picks a scene.
- **Physics engine friction isn't textbook friction.** We measured μ = 0.1 and μ = 0.8 looking almost the same in Matter.js, so we wrote our own Coulomb friction for the incline.
- **One step short.** Matter.js moves in whole steps, so every flight ended one step earlier than the theory. Correcting the launch velocity by half a step made the range, height and flight time match.
- **Mass that didn't matter.** In our first air-resistance model, changing the ball's mass also changed the drag itself, so a heavier ball flew exactly like a light one. Now the drag no longer changes with the mass, so a heavier ball flies farther, as it should.
- **A spring that slowly lost energy.** Matter.js soft constraints drain a little energy every cycle, and our top-up to hide it made the total-energy line wobble by 8.8%. We replaced the spring with its exact solution, and the line is now flat.
- **Being honest about the physics.** Real air resistance on a pendulum is too small to see, so the switch exaggerates it and says by how much ("real air ×N") instead of pretending.

## Accomplishments that we're proud of

- A photo of a hand-drawn pendulum turns into a clean, swinging pendulum in the same place, and its period matches 2π√(L/g). A drawn ball rolls at the measured 5/7 g sinθ, matching the theory.
- The split between CV and AI: the model labels, the computer vision measures. It's simple, and it means the simulation never puts things where you didn't draw them.
- It runs on a phone browser from a static site, with no backend.
- Eight kinds of drawing work: pendulum, spring, ramp with a block, ramp with a rolling ball, projectile, pulley, collision and seesaw, plus the fallback. With no AI at all, 42 of 42 test drawings were recognised and moved.

## What we learned

- Let each tool do what it's good at: OpenCV for geometry, an LLM for meaning, a physics engine for motion.
- Structured output (a JSON schema) plus validating everything that comes back makes an LLM reliable enough to sit inside a real-time app.
- Stability beats features in a live demo. A fallback that always moves something is worth more than one extra diagram type.
- Always have a plan for when the AI is down. Our offline guess started as a backup and became one of the most important parts of the app.

## What's next for Whiteboard Alive

- Point a live camera at a classroom whiteboard instead of taking a single photo.
- More topics: circuits, simple optics, 2-D collisions.
- A teacher mode: save a drawing and its simulation, share it as a link with the class.

## Built With

`typescript` `vite` `html5-canvas` `opencv.js` `matter.js` `poly-decomp` `gemini` `google-ai-studio` `web-speech-api` `github-pages` `github-actions`

## Try it out

- Live app: https://lukenicholls1222.github.io/whiteboard-alive/
- Source: https://github.com/LukeNicholls1222/whiteboard-alive

<!-- TODO: add demo video link -->
