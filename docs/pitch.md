# Whiteboard Alive — 3-minute pitch script

Total: 180 seconds. Times are targets; the live parts have a little slack built in.
Props: paper, two thick black markers, phone with the live site open (https://lukenicholls1222.github.io/whiteboard-alive/), laptop showing the phone screen or a mirrored tab, one "how it works" slide.

Every feature used below is live, except the example gallery (marked IN PROGRESS). If something goes wrong on stage, jump to "Backup plans" at the end.

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

*Tap **Show what AI saw**.*
> "And here's what it understood. Each colour is a role: this is the string, this is the weight."
*Tap again to hide it.*

## 4. Change it with your voice (1:00–1:25, 25s)

*Tap **Talk**, then say to the phone:*
> "Make gravity weaker."
*The gravity slider moves and the swing slows down. Point at the period readout and the energy graph.*
> "Lower gravity, longer period. You can watch it happen on the graph."

If voice doesn't respond within ~3 seconds (noisy room, mic permission), don't retry. Tap the **Moon** preset instead:
> "Or one tap: we're on the Moon now." *(same point about the period)*

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
- [ ] Keep a second tab open on the site with `?offline`, already loaded (OpenCV ready), as the backup tab
- [ ] Test Talk once in the venue (mic permission granted in the browser)

## Backup plans

**If the AI is slow** (the steps sit on "Understanding the drawing" for more than ~10 seconds):
1. Don't wait it out. Say: "Venue Wi-Fi — let me show you it works even without the AI."
2. Switch to the backup tab (https://lukenicholls1222.github.io/whiteboard-alive/?offline) and take the same photo again.
3. Say: "With no AI at all, it guesses from the shapes alone: triangles, circles, zig-zags. That got 15 out of 15 of our test drawings right."
4. The "Show what AI saw" colours and the sliders still work in this mode.

**If the Wi-Fi is dead** (the page won't load or nothing responds):
1. Use the example gallery and run one of the saved examples. It needs no network. (IN PROGRESS: check it's live before going on stage. If it isn't, switch to the backup `?offline` tab, which is already loaded, and snap the backup pre-drawn pendulum.)
2. Say: "The Wi-Fi died, but this is a saved run of exactly the same pipeline."
3. Then carry on from section 4 (sliders / Moon) as normal.
