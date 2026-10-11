# Whiteboard Alive — 3-minute pitch script

Total: 180 seconds. Times are targets; the live parts have a little slack built in.
Props: paper, two thick black markers, phone with the live site open (https://lukenicholls1222.github.io/whiteboard-alive/), laptop showing the phone screen or a mirrored tab, one "how it works" slide.

Every feature used below is live. If something goes wrong on stage, jump to "Backup plans" at the end.

---

## 1. Draw (0:00–0:25, 25s)

*Start drawing a pendulum on paper with the black marker while talking: a ceiling line, a string, a circle at the end.*

> "Every physics class has this moment. The teacher draws a pendulum, and says: *imagine it swinging.*
> Most of us can't. And simulation apps make you rebuild the problem with their menus and their clip-art.
> So we asked: what if your drawing could just turn into the simulation?"

## 2. Snap (0:25–0:40, 15s)

*Hold the paper up, take the photo on the phone. Point at the progress line on screen.*

> "I take a photo. It's finding my lines... and now the AI is reading the drawing. Nothing moves until it understands it."

## 3. It transforms (0:40–1:05, 25s)

*The colour overlay appears. Point at it.*

> "First, here's what it understood. Each colour is a role: this is the string, this is the weight."

*The light traces the drawing and the clean shapes snap in. Let it start swinging for a beat in silence.*

> "Now watch: it traces my drawing piece by piece, cleans it up, and turns it into a real pendulum, right where I drew it.
> My ceiling line is still there in the background. The swinging part is now the clean version."

## 4. Change it (1:05–1:25, 20s)

*Tap **Talk**, then say to the phone:*
> "Make the string 1 meter."
*The string length changes. Point at the period readout.*
> "One meter of string: the period is about two seconds, and the theory, 2π root L over g, agrees."

If voice doesn't respond within ~3 seconds (noisy room, mic permission), don't retry. Tap the **Length** pill right under the swinging picture and type 1 instead, or tap **Moon**:
> "Or one tap: we're on the Moon now. Lower gravity, longer period. You can watch it on the graph."

## 5. A judge draws (1:25–2:15, 50s)

*Hand a judge the judge sheet, paper and a black marker.*

> "Don't trust us. You draw one. A pendulum, a spring, a block or a ball on a ramp, a cannon, a pulley, two balls about to crash, or a seesaw. Use the black marker, and draw it big."

*While they draw (~25s), keep talking:*

> "There's no template. It reads whatever you draw, wobbly or broken, and builds the simulation from where your lines are.
> You don't need to write numbers. You can type the real lengths and masses in afterwards."

*Snap it, show the result.*

> "That's your drawing, turned into physics."

If they drew two balls colliding, tap the badge at the top left of the picture until it reads **SLOW MOTION 0.11×**, then point at the **first** hit between the balls and the green Total p line:
> "Watch the green line, the total momentum. When the two balls hit, it doesn't change. Momentum is conserved."

Total momentum is only conserved when the balls hit each other. When a ball bounces off a wall at the side, the total changes, because the wall pushes from outside. So always explain it on the first collision, before either ball reaches a wall.

If recognition misses:
> "It didn't recognise that one, so it falls back to plain gravity. It never just freezes. Real handwriting is messy, and that's exactly the problem we're working on."

## 6. How it works — one slide (2:15–2:45, 30s)

*Slide: Photo → OpenCV.js contours (numbered) → Gemini labels roles → Matter.js physics → clean figure traced from your drawing.*

> "Here's the trick. AI models are great at *what* something is, but bad at *exactly where* it is.
> So computer vision runs on the phone, finds every stroke, gives it a number, and measures it to the pixel.
> Gemini only answers: number 2 is the string, number 3 is the weight.
> All the positions come from the photo. Then Matter.js runs the physics on clean shapes built exactly where you drew.
> And if the AI is down, it guesses from the shapes alone. That got all 42 of our test drawings right.
> No server, it's just a web page. It runs on your phone right now."

## 7. What's next (2:45–3:00, 15s)

> "Next: point a camera at a real classroom whiteboard, add more topics like circuits and optics, and let teachers share a drawing as a link.
> Whiteboard Alive. Draw it, snap it, watch it move. Thank you!"

---

## Checklist before going on stage

- [ ] Live site loaded on the phone, OpenCV already downloaded (open it once, wait for it to be ready)
- [ ] Phone brightness up, screen mirroring working
- [ ] Two blank sheets + one backup pre-drawn pendulum in case the live drawing fails
- [ ] **Thick black markers only.** By default the app picks up black ink, so blue or thin pens are less reliable
- [ ] Good light on the paper, no strong shadow from the phone
- [ ] Keep a second tab open on the site with `?offline`, already loaded (OpenCV ready), as the backup tab
- [ ] Test Talk once in the venue (mic permission granted in the browser), e.g. "make the string 1 meter"
- [ ] Printed judge sheet (docs/judge-sheet.pdf) next to the paper

## Backup plans

**If the AI is slow** (the progress line sits on the AI step for more than ~10 seconds):
1. Don't wait it out. Say: "Venue Wi-Fi. Let me show you it works even without the AI."
2. Switch to the backup tab (https://lukenicholls1222.github.io/whiteboard-alive/?offline) and take the same photo again.
3. Say: "With no AI at all, it guesses from the shapes alone: triangles, circles, zig-zags. That got 42 out of 42 of our test drawings right."
4. The transformation, "Show what AI saw", the value pills, Your numbers and the sliders still work in this mode.

**If the Wi-Fi is dead** (the page won't load or nothing responds):
1. Use the example gallery and run one of the saved examples. It needs no network. If that fails too, switch to the backup `?offline` tab, which is already loaded, and snap the backup pre-drawn pendulum.
2. Say: "The Wi-Fi died, but this is a saved run of exactly the same pipeline."
3. Then carry on from section 4 (the value pills / Moon) as normal.

## If a judge asks

**"The total momentum changed. Isn't it supposed to be conserved?"**
> "It's conserved when the two balls hit each other: look at the first collision, the green total line stays flat. When a ball bounces off the wall at the side, the wall pushes on it from outside the system, so the total changes. That's correct physics: momentum is only conserved when there's no outside force."
