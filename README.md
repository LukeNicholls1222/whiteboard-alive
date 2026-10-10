# Whiteboard Alive

**Draw it. Snap it. Watch it move.**

Draw a physics diagram on paper and take a photo with your phone. Whiteboard Alive works out what each stroke is (string, weight, spring, ramp...), traces over your drawing part by part, and transforms it into a clean, moving physics simulation built exactly where you drew it.

Live demo: **https://lukenicholls1222.github.io/whiteboard-alive/** (works in a phone browser, no install)

Built at OCCHacks 2026 (Education track).

## How to use it

1. Draw one of the five diagrams below on white paper with a **thick black marker**.
2. Open the live site on your phone and take a photo (or pick one from your gallery).
3. A single progress line shows each step as it happens. Nothing moves until the drawing has been understood.
4. The transformation:
   - First, every stroke is coloured by the role it was given ("this is the string, this is the weight").
   - Then a light traces your drawing part by part: the fixed parts first, then the links, then the masses.
   - Each part snaps into a clean shape, and the simulation starts.
   - The fixed parts of your drawing stay faintly in the background. The hand-drawn moving parts fade out after a few seconds.
   - Tap **Show what AI saw** to bring the colour overlay back at any time.
5. Change the physics while it runs:
   - **Your numbers**: type in the real values. String length, mass, spring constant, ramp angle, launch speed, ground length, and the left and right pulley masses (whichever the diagram uses).
   - **Sliders**: Gravity (every diagram), Friction (incline), Launch speed (projectile).
   - **Gravity presets**: Earth, Moon and Jupiter. Moon mode makes a pendulum swing slowly enough to see the longer period.
   - **Voice**: tap **Talk** and say something like "make the string 1 meter" or "make gravity weaker". Voice can change every setting.
   - **Air resistance**: a switch. The label is honest about the scale: real air, or real air ×N when it is exaggerated so you can see the effect.
   - **Velocity arrows**: arrow length is proportional to speed, with a scale bar.
6. Below the simulation there is a live energy graph (potential energy measured from the lowest point) and the period, shown next to the theory value (2π√(L/g) for the pendulum).

## Supported diagrams

| Diagram | What you draw | What happens |
|---|---|---|
| Pendulum | Ceiling line, string, round bob | Swings |
| Spring and mass | Ceiling or wall, zig-zag, box | Oscillates |
| Incline | Triangle with a box on the slope | Slides down; friction can stop it |
| Projectile | Cannon or arrow, ball, ground | Flies in a parabola |
| Pulley | Wheel, rope over it, two weights | The heavier side drops |

If a drawing matches none of these, every drawn object becomes a rigid body and falls onto the ground. Something always moves.

## How it works

```
photo ─► OpenCV.js (on the phone) ─► numbered contours ─► Gemini labels each contour ─► Matter.js physics ─► clean shapes traced from your drawing
```

1. **Computer vision on the device (OpenCV.js).** By default only black ink is picked up, so stains, the desk, fold shadows and the paper edge don't become strokes. If the drawing is in blue pen, it switches to the general ink detection automatically. The photo is normalised against its own background, ruled or grid lines are erased, small breaks in strokes are joined, and specks are dropped. Each remaining contour is simplified (Douglas-Peucker) and given an id.
2. **The AI only labels; it never places anything (Gemini).** Gemini gets the photo with every contour outlined and numbered, plus the list of contours. It returns JSON (enforced with a response schema) giving the diagram type and the role of each contour id. All positions come from OpenCV, never from the model. Sizes and masses come from the numbers you type in, not from the paper.
3. **If the AI fails, the shapes still decide.** The app waits for the AI before anything moves. If every model fails or times out, a shape-based guess takes over: it looks for closed triangles, circles and boxes, filled-in blobs and zig-zag bands in the ink. Add `?offline` to the URL to force this mode.
4. **Physics (Matter.js).** Each diagram type has its own scene builder that turns roles into bodies and constraints. Stiffness and damping are fixed constants per diagram type, not chosen by the AI, so a scene behaves the same way every time. The incline adds its own Coulomb friction step.
5. **The transformation.** Each scene describes its own clean figure. A light traces the matching strokes part by part, the clean shape snaps in over them, and from then on the clean figure is what moves.
6. **Voice.** The Web Speech API turns speech into text. A keyword parser handles it first, instantly. Only if nothing matches does Gemini turn the text into a small diff such as `{"set": {"gravity": 1.6}}`.

**Test results.** On 33 test drawings in `samples/generated/` (clean, faint pencil, ruled paper, dim light, broken lines, and drawings that match no diagram), with no AI on the live site: the shape-based guess picked the right diagram for 32 of 33, and 32 of 33 moved.

## Run it locally

Requires Node.js.

```bash
npm ci
echo "VITE_GEMINI_API_KEY=your-key-here" > .env   # optional; without a key the shape-based guess is used
npm run dev
```

`npm run build` type-checks and builds the static site into `dist/`. Every push to `main` is built and deployed to GitHub Pages by GitHub Actions.

The Gemini key is used in the browser. Never commit `.env`. The deployed key is restricted by HTTP referrer to the GitHub Pages URL.

## Built With

TypeScript · Vite · HTML5 Canvas · OpenCV.js · Matter.js · poly-decomp · Gemini API (Google AI Studio) · Web Speech API · GitHub Pages · GitHub Actions

## Built during the hackathon

All code in this repository was written during OCCHacks 2026 (Oct 10–11, 2026):

- The full photo → contours → roles → physics pipeline
- Five diagram scenes plus the always-moving fallback
- The transformation from hand drawing to clean figure (colour overlay, tracing light, snap-in shapes)
- Black-ink detection and clean-up for messy phone photos
- Your numbers, gravity presets (Moon mode), air resistance, velocity arrows and voice control
- Live energy graph with period and theory value
- The shape-based guess for when the AI is unavailable
- 33 test drawings in `samples/generated/`, made with an image model
