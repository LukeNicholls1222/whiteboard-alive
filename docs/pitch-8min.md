# Whiteboard Alive — 8-minute pitch script

Slot: up to 8 minutes. This script ends at about **7:00**, which leaves 1 minute spare for a slow photo, a question or applause. The 3-minute version is still in `docs/pitch.md`.

Props: paper, two thick black markers, the phone with the live site open (https://lukenicholls1222.github.io/whiteboard-alive/), a laptop showing the phone screen, the two slides (https://lukenicholls1222.github.io/whiteboard-alive/slides/), and **one pre-drawn collision sheet** (two circles on a floor line, an arrow above each). A pre-drawn seesaw sheet is the spare.

Every feature used below is live. Each section has a "**If it goes wrong**" line. If you lose more than 20 seconds anywhere, skip the next "optional" line to catch up.

| Time | Section | Length |
|---|---|---|
| 0:00 | 1. The problem (drawing while talking) | 40s |
| 0:40 | 2. Demo 1: the pendulum transforms | 60s |
| 1:40 | 3. A learning moment: predict, then test | 60s |
| 2:40 | 4. Demo 2: the collision (pre-drawn) | 50s |
| 3:30 | 5. A judge draws | 80s |
| 4:50 | 6. How it works: two slides + the no-AI switch | 80s |
| 6:10 | 7. What was hard | 30s |
| 6:40 | 8. What's next and close | 20s |
| 7:00 | End (1 minute spare) | |

---

## 1. The problem (0:00–0:40, 40s)

*Start drawing a pendulum on paper with the black marker while you talk: a ceiling line, a string, a circle at the end. Draw it big.*

> "Every physics class has this moment. The teacher draws a pendulum on the board and says: *now imagine it swinging.*
> Half the room can't. And the ones who can, can't tell you what happens if the string gets longer, or if we're on the Moon.
> Simulation apps exist, but they make you rebuild the problem with their menus and their clip-art. You stop thinking about physics and start thinking about the app.
> So we asked a simple question: what if the drawing you already made could just come alive?"

*Finish the drawing as you say the last line.*

**If it goes wrong:** if the marker is dry or the drawing looks bad, take the spare marker and redraw. Don't apologise; keep talking.

## 2. Demo 1: the pendulum transforms (0:40–1:40, 60s)

*Hold the paper flat, phone straight above it, take the photo. Point at the progress line on the screen.*

> "I take one photo. First it's finding my lines, right here on the phone. Now the AI is reading the drawing. Nothing moves until it has understood it."

*The colour overlay appears. Point at each colour.*

> "Here's what it understood. Each colour is a role: this is the ceiling, this is the string, this is the weight."

*The light traces the drawing and the clean shapes snap in. Stay silent for two seconds while it starts to swing.*

> "Now watch. It traces my drawing piece by piece, cleans each part up, and turns it into a real pendulum, exactly where I drew it.
> My ceiling line is still there in the background. The part that moves is now the clean version.
> That's not a template. That's my pendulum."

**If it goes wrong:**
- The AI step sits for more than ~10 seconds: say "Venue Wi-Fi. Let me show you it works even without the AI," switch to the `?offline` backup tab and take the same photo again. Then keep going. (You'll explain the offline mode properly in section 6.)
- It picks the wrong diagram: tap an example from "Or try one of ours" (the pendulum) and say "Here's one we drew earlier." Carry on with section 3.

## 3. A learning moment: predict, then test (1:40–2:40, 60s)

*Before you start: tap the **Length** pill under the swinging picture and set it to **0.25 m**. Point at the period readout (about 1.0 s).*

> "This is where it becomes a lesson. Right now the string is 25 centimetres and the period is about one second.
> Quick question for you." *(Look at a judge.)* "If I make the string **four times longer**, what happens to the period? Twice as long? Four times? Have a guess."

*Wait for an answer. Whatever they say, nod.*

> "Let's test it."

*Tap **Talk** and say to the phone:*

> "Make the string 1 meter."

*The string grows. Point at the measured period next to the theory value.*

> "Four times the length, and the period is about two seconds: only **twice** as long. And here's the theory next to it, 2π root L over g. Measured and predicted, side by side. Students don't just watch it, they check it."

*Tap **Moon**.*

> "And one more tap: we're on the Moon. Gravity is a sixth, so the same pendulum swings more slowly. You can see it on the graph."

**If it goes wrong:**
- Voice doesn't respond within ~3 seconds (noise, mic permission): don't retry. Tap the **Length** pill and type 1 instead. Say "The room's a bit loud, so I'll type it."
- The judge's guess is "twice": say "Exactly right. Let's prove it." Then run the test as above.

## 4. Demo 2: the collision, pre-drawn (2:40–3:30, 50s)

*Pick up the pre-drawn collision sheet: a floor line, two circles, an arrow above each.*

> "Pendulums are the classic. But it understands more than that. Here's one I drew earlier: two balls about to crash."

*Take the photo. When it runs, point at the graph card and the green **Total p** line. Point at the **first** hit between the two balls.*

> "This green line is the total momentum of both balls. Watch the moment they hit each other... it stays flat. Momentum is conserved, and you can see it.
> I can also change the bounciness. One is a perfectly elastic bounce, zero means they stick together."

*Optional (only if you're on time): drag **Bounciness e** to 0 and let them stick.*

Only explain momentum on the **first** collision between the balls. When a ball bounces off a wall at the side, the total changes, because the wall pushes from outside. If a judge spots it, see "If a judge asks" at the end.

**If it goes wrong:**
- It isn't recognised as a collision: switch to the pre-drawn **seesaw** sheet. Point at the Torque balance card and say: "Same idea with a seesaw: it tips toward the side with the bigger moment, mass times g times distance, and it tells you which side wins."
- Both fail: run the collision from the example gallery and say "Here's the saved run."

## 5. A judge draws (3:30–4:50, 80s)

*Hand a judge the printed judge sheet (`docs/judge-sheet.pdf`), a blank sheet and a black marker.*

> "Don't trust us. You draw one. Pick anything on that sheet: a pendulum, a spring, a block or a ball on a ramp, a cannon, a pulley, two balls about to crash, or a seesaw. Use the black marker, and draw it big."

*While they draw (~30–40s), keep talking. Don't stare at them.*

> "There's no template. It reads whatever you draw, wobbly or broken lines included, and builds the simulation from exactly where your lines are.
> You don't need to write any numbers. Every value sits right under the moving picture. Tap it and change it while it moves."

*Take the photo, show the result. Hand them the phone if they want to play with a value pill.*

> "That's your drawing, turned into physics."

**If it goes wrong:**
- Recognition misses: "It didn't recognise that one, so it falls back to plain gravity. It never just freezes. Real handwriting is messy, and that's exactly the problem we spent most of our time on." Then go straight to section 6, which explains that.
- The judge is still drawing at 4:30: say "Take your time, I'll show you how it works and we'll run yours at the end." Run it after section 8, inside the spare minute.

## 6. How it works: two slides and the no-AI switch (4:50–6:10, 80s)

*Show slide 1 (https://lukenicholls1222.github.io/whiteboard-alive/slides/, press the right arrow or tap to go forward).*

**Slide 1: Photo → OpenCV.js → Gemini → Matter.js**

> "Here's the trick. AI models are great at *what* something is, but bad at *exactly where* it is.
> So computer vision runs on the phone. OpenCV finds every stroke, gives it a number, and measures it to the pixel.
> Gemini only answers one question: what is each number? Number 2 is the string, number 3 is the weight. It never gives a coordinate.
> Then Matter.js runs the physics on clean shapes built exactly where you drew. No server, it's just a web page."

*Next slide.*

**Slide 2: Messy photos, and no AI at all**

> "Real photos are messy: shadows, faint lines, ruled paper, the edge of the desk. So we only pick up black ink, flatten the lighting against the paper itself, and join broken strokes.
> And if the AI is down, it guesses from the shapes alone: triangles, circles, boxes, zig-zags. On our 42 test drawings, with no AI at all, it got 42 out of 42 right, and all 42 moved.
> Let me show you."

*Switch the phone to the `?offline` backup tab and take a photo of the **same pendulum sheet** from section 1.*

> "This tab has no AI at all. Same paper... and it still swings."

**If it goes wrong:**
- The slides won't open: skip them and say the same lines while pointing at the phone.
- The offline photo picks the wrong diagram: say "And that's why we still use the AI when it's there," and move on. Don't retake.

## 7. What was hard (6:10–6:40, 30s)

> "Three things were hard.
> One: getting the AI to stop inventing coordinates. Early on we asked it where the pivot was, and it was always close but never exact. Giving it numbered strokes and only asking for roles fixed that.
> Two: real photos. Most of our time went into shadows, faint pencil and broken lines.
> Three: honest physics. The physics engine's friction isn't textbook friction, so we wrote our own. And real air resistance on a pendulum is too small to see, so when we exaggerate it, the app tells you by how much."

**If it goes wrong:** if you're running late (past 6:20), say only "One" and skip the other two.

## 8. What's next and close (6:40–7:00, 20s)

> "Next: point a live camera at a real classroom whiteboard, add circuits and optics, and let a teacher share a drawing with the class as a link.
> Whiteboard Alive. Draw it, snap it, watch it move. Thank you!"

*Spare minute (7:00–8:00): run the judge's drawing if it wasn't finished, or take a question.*

---

## Checklist before going on stage

- [ ] Live site loaded on the phone, OpenCV already downloaded (open it once, wait for it to be ready)
- [ ] Phone brightness up, screen mirroring working
- [ ] Two blank sheets + one backup pre-drawn pendulum in case the live drawing fails
- [ ] Pre-drawn **collision** sheet, plus a pre-drawn **seesaw** sheet as the spare. Run both through the live site once before going on
- [ ] **Thick black markers only.** By default the app picks up black ink, so blue or thin pens are less reliable
- [ ] Good light on the paper, no strong shadow from the phone
- [ ] Keep a second tab open on the site with `?offline`, already loaded (OpenCV ready), as the backup tab. Section 6 uses it on purpose
- [ ] Test Talk once in the venue (mic permission granted in the browser), e.g. "make the string 1 meter"
- [ ] Rehearse section 3 once: set the Length pill to 0.25 m and check the period reads about 1 s, then 1 m reads about 2 s
- [ ] Slides open on the laptop (https://lukenicholls1222.github.io/whiteboard-alive/slides/) and tested with the arrow keys
- [ ] Printed judge sheet (`docs/judge-sheet.pdf`) next to the paper
- [ ] A timer the speaker can see. Checkpoints: 1:40 Learning moment, 3:30 Judge draws, 4:50 Slides, 6:40 Close

## Backup plans

**If the AI is slow** (the progress line sits on the AI step for more than ~10 seconds):
1. Don't wait it out. Say: "Venue Wi-Fi. Let me show you it works even without the AI."
2. Switch to the backup tab (https://lukenicholls1222.github.io/whiteboard-alive/?offline) and take the same photo again.
3. Say: "With no AI at all, it guesses from the shapes alone: triangles, circles, zig-zags. That got 42 out of 42 of our test drawings right."
4. The transformation, "Show what AI saw", the value pills, Your numbers and the sliders still work in this mode.
5. In section 6, you've already shown the offline mode, so just point back to it instead of switching again.

**If the Wi-Fi is dead** (the page won't load or nothing responds):
1. Use the example gallery and run one of the saved examples. It needs no network. If that fails too, switch to the backup `?offline` tab, which is already loaded, and snap the backup pre-drawn pendulum.
2. Say: "The Wi-Fi died, but this is a saved run of exactly the same pipeline."
3. Then carry on from section 3 (the value pills / Moon) as normal.

**If you're running late:**
- Past 3:40 when the judge starts drawing: drop the optional Bounciness line in section 4 next time, and shorten section 7 to one point.
- Past 6:30 at section 7: skip straight to section 8.

## If a judge asks

**"The total momentum changed. Isn't it supposed to be conserved?"**
> "It's conserved when the two balls hit each other: look at the first collision, the green total line stays flat. When a ball bounces off the wall at the side, the wall pushes on it from outside the system, so the total changes. That's correct physics: momentum is only conserved when there's no outside force."

**"Does the AI decide where things are?"**
> "Never. The AI only says what each numbered stroke is. Every position comes from the computer vision measuring the photo."

**"What if the AI is down?"**
> "It guesses from the shapes alone. That's the offline tab we just showed you: 42 out of 42 of our test drawings."
