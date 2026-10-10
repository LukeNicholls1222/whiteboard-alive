# Whiteboard Alive

**Draw it. Snap it. Watch it move.**

Draw a physics diagram on paper, take a photo with your phone, and the lines *you* drew start moving as a physics simulation. The AI works out what each stroke is (string, weight, spring, ramp...). Your own ink is cut out of the photo and becomes the moving parts, so you never re-draw anything.

Live demo: **https://lukenicholls1222.github.io/whiteboard-alive/** (works in a phone browser, no install)

Built at OCCHacks 2026 (Education track).

## How to use it

1. Draw one of the five diagrams below on white paper with a dark marker.
2. Open the live site on your phone and take a photo (or pick one from your gallery).
3. The steps are shown as they happen: *Finding your lines → Understanding the drawing → Bringing it to life*.
4. Before the simulation starts, the app briefly colours each stroke by the role it was given. Tap **Show what AI saw** to bring that overlay back at any time.
5. Change the physics while it runs:
   - **Sliders**: Gravity (every diagram), Friction (incline), Launch speed (projectile).
   - **Gravity presets**: Earth, Moon, Jupiter. Moon mode makes a pendulum swing slowly enough to see the longer period.
   - **Voice**: tap **Talk** and say something like "make gravity weaker".
6. Below the simulation there is a live energy graph (last 8 seconds) and a readout of the period (pendulum, spring) or speed.

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
photo ─► OpenCV.js (on the phone) ─► numbered contours ─► Gemini labels each contour ─► Matter.js physics ─► your ink drawn on each body
```

1. **Computer vision on the device (OpenCV.js).** The photo is normalised against its own background, so shadows and uneven light cancel out. The paper is separated from the desk, ruled or grid lines are erased, small breaks in strokes are joined, and specks and stray handwriting are dropped. Each remaining contour is simplified (Douglas-Peucker) and given an id.
2. **The AI only labels; it never places anything (Gemini).** Gemini gets the photo with every contour outlined and numbered, plus the list of contours. It returns JSON (enforced with a response schema) giving the diagram type, the role of each contour id, and the constraints between them. All coordinates come from OpenCV, never from the model, so nothing ends up somewhere you didn't draw it.
3. **If the AI fails, the shapes still decide.** When Gemini is unavailable (quota, slow network, offline), a shape-based guess takes over. It looks for closed triangles, circles and boxes, filled-in blobs and zig-zag bands in the ink. It got 15 of 15 of our generated test drawings right. Add `?offline` to the URL to force this mode.
4. **Physics (Matter.js).** Each diagram type has its own scene builder that turns roles into bodies and constraints. Stiffness and damping are fixed constants per diagram type, not chosen by the AI, so a scene behaves the same way every time. The incline adds its own Coulomb friction step, so the friction slider changes how the block slides.
5. **Your drawing is the sprite.** The strokes of every moving body are cut out of the photo and drawn on top of that body every frame.
6. **Voice.** The Web Speech API turns speech into text. Gemini turns the text into a small diff such as `{"set": {"gravity": 1.6}}`, which is applied immediately. If Gemini is unavailable, a keyword parser handles common phrases.

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
- Clean-up for messy phone photos (shadows, desk, ruled paper, broken lines)
- The colour-coded "what the AI saw" overlay
- Sliders, gravity presets (Moon mode) and voice control
- Live energy graph with period readout
- The shape-based offline guess
- Test drawings in `samples/`: 15 generated with an image model, 15 of 15 working on the live site
