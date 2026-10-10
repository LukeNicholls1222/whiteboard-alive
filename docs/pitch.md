# Whiteboard Alive — 3-minute pitch script

Total: 180 seconds. Times are targets; the live parts have a little slack built in.
Props: paper, two thick black markers, phone with the live site open (https://lukenicholls1222.github.io/whiteboard-alive/), laptop showing the phone screen or a mirrored tab, one "how it works" slide.

<!-- TODO: lines marked PLANNED depend on features that aren't live yet. If a feature doesn't ship, use the fallback line instead. -->

---

## 1. Draw (0:00–0:25, 25s)

*Start drawing a pendulum on paper while talking: a dot, a line, a circle at the end.*

> "Every physics class has this moment. The teacher draws a pendulum, and says: *imagine it swinging.*
> Most of us can't. And simulation apps make you rebuild the problem with their menus and their clip-art.
> So we asked: what if the drawing itself could just... move?"

## 2. Snap (0:25–0:40, 15s)

*Hold the paper up, take the photo on the phone. Point at the progress steps on screen.*

> "I take a photo. It's finding my lines... understanding the drawing... and—"

## 3. It moves (0:40–1:00, 20s)

*The pendulum swings. Let it swing for a beat in silence.*

> "That's not a cartoon pendulum. That's *my* ink. The exact line I drew is now a rope, and my circle is the weight.
> It knows the dot is the pivot, the line is the string, the circle is the mass."

<!-- TODO: if the colour overlay ships, show it here: "Here's what it understood — blue is the string, orange is the weight." -->

## 4. Change it with your voice (1:00–1:25, 25s)

PLANNED (voice control):
> "Now let's take it to the Moon." *(say it to the phone)*
> *Gravity drops, the swing slows down. Point at the period graph.*
> "Lower gravity, longer period — and you can watch that happen on the graph."

Fallback if voice / graphs are not live:
> "And it's not just pendulums." *Snap a second pre-drawn sheet (spring or incline, whichever is most reliable) and let it run.*

<!-- TODO: pick the final version of this part after Phase 2 -->

## 5. A judge draws (1:25–2:15, 50s)

*Hand a judge the paper and a marker.*

> "Don't trust us — you draw one. A pendulum, a spring, a block on a ramp, a cannon, a pulley. Anything."

*While they draw (~25s), keep talking:*

> "There's no template here. Whatever lines you draw — wobbly, broken, off the edge — that's what's going to move."

*Snap it, show the result.*

> "That's your drawing. Moving."

If recognition misses:
> "It didn't recognise that one, so it falls back to plain gravity — it never just freezes. Real handwriting is messy, and that's exactly the problem we're working on."

## 6. How it works — one slide (2:15–2:45, 30s)

*Slide: Photo → OpenCV.js contours (numbered) → Gemini labels roles → Matter.js physics → your ink as sprites.*

> "Here's the trick. AI models are great at *what* something is, but bad at *exactly where* it is.
> So computer vision runs on the phone and finds every stroke, gives it a number, and measures it to the pixel.
> Gemini only answers: number 2 is the string, number 3 is the weight.
> All the geometry stays from the photo. Then Matter.js runs the physics, and we glue your cut-out drawing onto each body.
> No server, it's just a web page — it runs on your phone right now."

## 7. What's next (2:45–3:00, 15s)

> "Next: point a camera at a real classroom whiteboard, add more topics like collisions and circuits, and let teachers share a drawing as a link.
> Whiteboard Alive. Draw it, snap it, watch it move. Thank you!"

---

## Checklist before going on stage

- [ ] Live site loaded on the phone, OpenCV already downloaded (open it once, wait for it to be ready)
- [ ] Phone brightness up, screen mirroring working
- [ ] Two blank sheets + one backup pre-drawn pendulum in case the live drawing fails
- [ ] Markers are thick and dark (thin pens are harder to detect)
- [ ] Good light on the paper, no strong shadow from the phone
- [ ] <!-- TODO: offline sample results ready in case the venue Wi-Fi is down -->
