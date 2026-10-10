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

While it runs you can change the physics:

- **Sliders**: gravity (every diagram), friction (incline), launch speed (projectile).
- **Gravity presets**: Earth, Moon, Jupiter. In Moon mode a pendulum visibly slows down.
- **Voice**: tap Talk and say "make gravity weaker". The Web Speech API transcribes it, Gemini turns it into a parameter change, and if Gemini is unavailable a keyword parser handles common phrases.
- **Live graph**: kinetic and potential energy over the last 8 seconds, plus the measured period (pendulum, spring) or speed.
- **Show what AI saw**: the photo with every detected stroke coloured by its role ("this is the string, this is the weight"). It is shown briefly before the simulation starts and can be brought back with one tap.

It also shows its progress step by step ("Finding your lines → Understanding the drawing → Bringing it to life") so the screen never looks frozen, and if it can't recognise the drawing it still makes something fall — it never just sits there.

**Diagram types**

| Diagram | Status |
|---|---|
| Pendulum (pivot, string, bob → swings) | Working |
| "Anything else" fallback (object + ground → it falls) | Working |
| Spring and mass (zig-zag + box → oscillates) | Working |
| Incline (triangle + box → slides, friction stops it) | Working |
| Projectile (cannon or arrow → parabola) | Working |
| Pulley (wheel + rope + two weights → heavier one drops) | Working |

**In progress**

- A gallery of example drawings with saved results, so the demo works without Wi-Fi or the AI

## How we built it

The whole app is a static web page — no server of our own. It runs in the phone's browser.

**1. Computer vision on the device (OpenCV.js)**
Phone photos are messy, so the image is cleaned up before any contour is extracted. Each pixel is compared with a smoothed estimate of the background, so shadows, vignetting and lamp gradients cancel out. The paper is separated from the desk, and lines on ruled or grid paper are erased. Breaks in strokes are joined along the stroke skeleton, and specks and stray handwriting are filtered out. Then we extract contours and simplify each one with Douglas-Peucker. Every contour gets an id, a bounding box, a centroid, an ink-pixel count, and a flag for whether it's a closed loop.

**2. The AI only labels — it never guesses coordinates (Gemini)**
This is the key design choice. We send Gemini two things: the photo with each contour outlined and labelled `#0`, `#1`, ..., and the list of contours with their real pixel data. Gemini returns structured JSON (enforced with a response schema): the diagram type, a role for each contour id (pivot, rope, bob, spring, mass...), the constraints between them, and a one-sentence explanation.

Language models are bad at pixel-exact positions but good at "that circle is the weight." So all geometry comes from OpenCV, and the AI only answers *what* each shape is. The answer is sanitised before use: unknown ids are dropped, numbers are clamped, and missing fields get defaults. If every model fails or times out, a shape-based guess takes over (see below).

**2b. A guess from the shapes alone (no AI)**
When Gemini is unavailable (free-tier quota, a slow venue network, no connection), the app still has to pick the right scene. The fallback guess works on the ink itself. It finds closed triangles, circles and boxes by how much of their bounding rectangle they fill, picks out filled-in blobs, and finds zig-zag bands where scan lines cross the ink at regular spacing. On our 15 generated test drawings it chose the right diagram 15 of 15 times. Adding `?offline` to the URL forces this mode.

**3. Physics (Matter.js)**
Each diagram type has its own scene builder that turns roles into rigid bodies and constraints. Physics shapes are simplified convex polygons (with poly-decomp available for concave ones). Stiffness and damping for each constraint are fixed constants per diagram type, chosen by us — not by the AI — so the simulation behaves the same way every time. Matter.js friction at low speeds behaves more like drag, so the friction slider barely changed anything. The incline therefore applies its own Coulomb friction step after every physics update, and the slider now visibly changes the slide.

**4. Your drawing *is* the sprite**
For every moving body we cut the matching strokes out of the photo (transparent outside the shape), erase them from the background, and draw the cut-out on top of the rigid body every frame. That's why it looks like the paper itself came alive.

**5. Voice**
The Web Speech API turns speech into text. Gemini turns the text into a small diff such as `{"set": {"gravity": 1.6}}`, and the simulation applies it immediately. If Gemini is unavailable, a keyword parser handles common phrases.

**6. Hosting**
Vite + TypeScript with a plain Canvas (no framework). GitHub Actions builds on every push to `main` and deploys to GitHub Pages. The Gemini key is injected at build time and locked to our Pages URL with an HTTP referrer restriction; it will be deleted after the event.

## Challenges we ran into

- **Real photos are messy.** Shadows, faint pencil, broken lines and strokes running off the page. Normalising against the background, removing ruled lines and joining broken strokes on the skeleton got all 15 of our generated test photos working on the live site (15 of 15).
- **Getting the AI to stop inventing coordinates.** Early on it's tempting to ask the model "where is the pivot?" — the answers were close but never exact. Giving it numbered contours and only asking for roles fixed this.
- **"Nothing happens" is the worst outcome.** We built the fallback scene first, so even a drawing we don't understand still drops something.
- **Free-tier AI quotas and slow responses.** Each Gemini model attempt is capped at 9 seconds, and the app falls through a chain of Flash models. If all of them fail, the shape-based guess still picks a scene.
- **Physics engine friction isn't textbook friction.** We measured μ = 0.1 and μ = 0.8 looking almost the same in Matter.js, so we wrote our own Coulomb friction for the incline.

## Accomplishments that we're proud of

- A photo of a hand-drawn pendulum swings, using the actual ink from the paper.
- The split between CV and AI: the model labels, the computer vision measures. It's simple, and it means the simulation never puts things where you didn't draw them.
- It runs on a phone browser from a static site, with no backend.
- All five diagram types work, and 15 of 15 generated test photos work on the live site.
- Even with no AI at all, the shape-based guess picks the right diagram for 15 of 15 test drawings.

## What we learned

- Let each tool do what it's good at: OpenCV for geometry, an LLM for meaning, a physics engine for motion.
- Structured output (a JSON schema) plus validating everything that comes back makes an LLM reliable enough to sit inside a real-time app.
- Stability beats features in a live demo. A fallback that always moves something is worth more than one extra diagram type.
- Always have a plan for when the AI is down. Our offline guess started as a backup and became one of the most important parts of the app.

## What's next for Whiteboard Alive

- Finish the example gallery so the demo runs fully offline.
- Point a live camera at a classroom whiteboard instead of taking a single photo.
- More topics: collisions, circuits, simple optics.
- A teacher mode: save a drawing and its simulation, share it as a link with the class.

## Built With

`typescript` `vite` `html5-canvas` `opencv.js` `matter.js` `poly-decomp` `gemini` `google-ai-studio` `web-speech-api` `github-pages` `github-actions`

## Try it out

- Live app: https://lukenicholls1222.github.io/whiteboard-alive/
- Source: https://github.com/LukeNicholls1222/whiteboard-alive

<!-- TODO: add demo video link -->
