// While a number under the picture is being changed (quick.ts, a pill is open), the picture never gets shorter: a
// rebuilt scene may want a smaller picture (a slower launch, a lower cannon), and the − / + buttons under it would jump
// up, towards the top of the page where scrolling cannot make up for it. Growing is still allowed (the page scrolls
// down to keep the buttons in place). sim.ts reads this when it sizes the picture. No imports: quick.ts stays testable.

export const pictureHold = {
  on: false,
  /** Tallest CSS height the picture had while held (it is not drawn shorter than this). */
  px: 0,
};

/** Hold (a pill opened) or let go (closed): the next picture may be any height again. */
export function holdPictureHeight(on: boolean) {
  if (on === pictureHold.on) return;
  pictureHold.on = on;
  pictureHold.px = 0;
}
