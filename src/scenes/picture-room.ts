// The room a moving part keeps on the picture (pendulum, spring): the picture's CSS width and, per edge, the CSS px
// kept clear: EDGE_CSS all round, and at the top the row of buttons floating over the picture (the speed badge,
// "Show what AI saw") plus EDGE_CSS. Read from the page every few frames; without a page (tests) a phone-width
// picture with the usual row of buttons.

import { EDGE_CSS, type Insets, TOP_ROW_FALLBACK_CSS } from './pendulum-view';

/** Floating buttons whose top is within this of the picture's top edge make up the top row (CSS px, as vectors.ts). */
const TOP_ROW_CSS = 60;
/** Frames between two readings of the page (the buttons show and hide on their own; the card may be resized). */
const ROOM_EVERY = 20;
let room: { cssW: number; insets: Insets; age: number } | null = null;

export function pictureRoom(): { cssW: number; insets: Insets } {
  if (room && ++room.age < ROOM_EVERY) return room;
  let cssW = 390, topRow = TOP_ROW_FALLBACK_CSS;
  const canvas = typeof document !== 'undefined' ? document.getElementById('stage') : null;
  if (canvas) {
    cssW = canvas.clientWidth || cssW;
    const cr = canvas.getBoundingClientRect();
    let seen = false, y = 0;
    for (const el of canvas.parentElement?.querySelectorAll<HTMLElement>('.time-badge, .btn-float') ?? []) {
      if (el.hidden || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.top - cr.top > TOP_ROW_CSS) continue;
      seen = true;
      y = Math.max(y, r.bottom - cr.top);
    }
    if (seen) topRow = y;
  }
  room = { cssW, insets: { left: EDGE_CSS, right: EDGE_CSS, top: topRow + EDGE_CSS, bottom: EDGE_CSS }, age: 0 };
  return room;
}
