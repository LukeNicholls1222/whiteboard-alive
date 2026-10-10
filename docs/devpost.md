# Whiteboard Alive — Devpost draft

> Draft for the OCCHacks 2026 submission (Education track).
> Anything marked `<!-- TODO -->` must be filled in or checked before we submit.
> Rule for this file: only describe what actually works on the live site. Anything still in progress goes under "planned".

**Tagline:** Draw a physics diagram on paper, snap a photo, and watch *your own lines* start to move.

---

## Inspiration

Every physics class has the same moment: the teacher draws a pendulum or a block on a ramp on the whiteboard, and then says "now imagine it moving." Half the room can't.

Simulation apps exist, but they make you rebuild the problem with their sliders and their clip-art. We wanted the opposite: keep the messy drawing you already made, and make *that* move. No menus, no re-drawing — the sketch is the input.

<!-- TODO: add a personal line from the team (e.g. a class where this would have helped) -->

## What it does

1. You draw a physics diagram on paper (or a whiteboard).
2. You take a photo with your phone, right in the browser.
3. Whiteboard Alive finds your strokes, figures out what each one *is* (a pivot, a string, a weight, a spring...), and turns them into a physics simulation.
4. The strokes you drew are cut out of the photo and attached to the physics bodies, so it's your handwriting that swings, bounces and slides.

It also shows its progress step by step ("Finding your lines → Understanding the drawing → Bringing it to life") so the screen never looks frozen, and if it can't recognise the drawing it still makes something fall — it never just sits there.

**Diagram types**

| Diagram | Status |
|---|---|
| Pendulum (pivot, string, bob → swings) | Working |
| "Anything else" fallback (object + ground → it falls) | Working |
| Spring and mass (zig-zag + box → oscillates) | <!-- TODO: in progress, update when merged --> |
| Incline (triangle + box → slides, friction stops it) | <!-- TODO: in progress, update when merged --> |
| Projectile (cannon or arrow → parabola) | <!-- TODO: in progress, update when merged --> |
| Pulley (wheel + rope + two weights → heavier one drops) | <!-- TODO: in progress, update when merged --> |

**Planned (not live yet)**

- Change the physics with your voice: "make gravity weaker", "make the string longer"
- Sliders for the same parameters
- Live graphs of period and energy while it moves
- Moon mode (one tap to switch to lunar gravity)
- An overlay that colours each stroke by what the AI thought it was ("this is the string, this is the weight")

<!-- TODO: move each item above into "What it does" as it ships, and delete the ones we don't finish -->

## How we built it

The whole app is a static web page — no server of our own. It runs in the phone's browser.

**1. Computer vision on the device (OpenCV.js)**
The photo is scaled down, converted to grayscale, blurred, and binarised with an adaptive threshold (so shadows and uneven lighting don't wreck it). A morphological close joins small gaps in the pen strokes. Then we extract contours and simplify each one with Douglas-Peucker. Every contour gets an id, a bounding box, a centroid, an ink-pixel count, and a flag for whether it's a closed loop.

**2. The AI only labels — it never guesses coordinates (Gemini)**
This is the key design choice. We send Gemini two things: the photo with each contour outlined and labelled `#0`, `#1`, ..., and the list of contours with their real pixel data. Gemini returns structured JSON (enforced with a response schema): the diagram type, a role for each contour id (pivot, rope, bob, spring, mass...), the constraints between them, and a one-sentence explanation.

Language models are bad at pixel-exact positions but good at "that circle is the weight." So all geometry comes from OpenCV, and the AI only answers *what* each shape is. The answer is sanitised before use: unknown ids are dropped, numbers are clamped, and missing fields get defaults. If the call fails or times out, a simple offline heuristic takes over.

**3. Physics (Matter.js)**
Each diagram type has its own scene builder that turns roles into rigid bodies and constraints. Physics shapes are simplified convex polygons (with poly-decomp available for concave ones). Stiffness and damping for each constraint are fixed constants per diagram type, chosen by us — not by the AI — so the simulation behaves the same way every time.

**4. Your drawing *is* the sprite**
For every moving body we cut the matching strokes out of the photo (transparent outside the shape), erase them from the background, and draw the cut-out on top of the rigid body every frame. That's why it looks like the paper itself came alive.

**5. Voice** <!-- TODO: planned, not built yet -->
Plan: Web Speech API turns speech into text, Gemini turns the text into a small diff like `{"set": {"gravity": 1.6}}`, and the simulation applies it instantly.

**6. Hosting**
Vite + TypeScript with a plain Canvas (no framework). GitHub Actions builds on every push to `main` and deploys to GitHub Pages. The Gemini key is injected at build time and locked to our Pages URL with an HTTP referrer restriction; it will be deleted after the event.

## Challenges we ran into

- **Real photos are messy.** Shadows, faint pencil, broken lines and strokes running off the page. Adaptive thresholding plus closing small gaps helped a lot. <!-- TODO: add concrete numbers from our sample tests, e.g. "X of Y photos worked" -->
- **Getting the AI to stop inventing coordinates.** Early on it's tempting to ask the model "where is the pivot?" — the answers were close but never exact. Giving it numbered contours and only asking for roles fixed this.
- **"Nothing happens" is the worst outcome.** We built the fallback scene first, so even a drawing we don't understand still drops something.
- **Making cut-out sprites follow a swinging rope** without tearing the drawing apart. <!-- TODO: confirm this is still how we describe it -->
- <!-- TODO: anything else that bit us during the 30 hours -->

## Accomplishments that we're proud of

- A photo of a hand-drawn pendulum swings, using the actual ink from the paper.
- The split between CV and AI: the model labels, the computer vision measures. It's simple, and it means the simulation never puts things where you didn't draw them.
- It runs on a phone browser from a static site, with no backend.
- <!-- TODO: "N of M first-time drawings worked" from the final test run -->
- <!-- TODO: the live demo where judges drew their own diagram -->

## What we learned

- Let each tool do what it's good at: OpenCV for geometry, an LLM for meaning, a physics engine for motion.
- Structured output (a JSON schema) plus validating everything that comes back makes an LLM reliable enough to sit inside a real-time app.
- Stability beats features in a live demo. A fallback that always moves something is worth more than one extra diagram type.
- <!-- TODO: one more honest lesson from the weekend -->

## What's next for Whiteboard Alive

- Finish and polish voice control, sliders, graphs and moon mode (see "Planned" above). <!-- TODO: trim to what's still unfinished at submission time -->
- Point a live camera at a classroom whiteboard instead of taking a single photo.
- More topics: collisions, circuits, simple optics.
- A teacher mode: save a drawing and its simulation, share it as a link with the class.

## Built With

`typescript` `vite` `html5-canvas` `opencv.js` `matter.js` `poly-decomp` `gemini` `google-ai-studio` `github-pages` `github-actions`

<!-- TODO: add `web-speech-api` once voice control ships -->

## Try it out

- Live app: https://lukenicholls1222.github.io/whiteboard-alive/
- Source: https://github.com/LukeNicholls1222/whiteboard-alive

<!-- TODO: add demo video link -->
