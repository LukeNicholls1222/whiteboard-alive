// Helpers shared by scene builders: masks, cut-out sprites, background erasing.

import type { Contour, Point, SceneInput } from '../types';

/** Pixel mask (1 = inside) of the given contours, filled, with a small stroke margin. */
export function contourMask(input: SceneInput, contours: Contour[], margin = 4): Uint8Array {
  const { width: W, height: H } = input;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = margin * 2;
  ctx.lineJoin = 'round';
  for (const k of contours) {
    if (k.points.length < 2) continue;
    ctx.beginPath();
    k.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  const d = ctx.getImageData(0, 0, W, H).data;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] > 0 ? 1 : 0;
  return mask;
}

export function maskBounds(mask: Uint8Array, W: number, H: number) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (mask[y * W + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Cut the masked region out of the paper image. Returns the sprite canvas and its top-left offset. */
export function cutSprite(input: SceneInput, mask: Uint8Array): { image: HTMLCanvasElement; offset: Point } {
  const { width: W, height: H, paper } = input;
  const b = maskBounds(mask, W, H) ?? { x: 0, y: 0, w: 1, h: 1 };
  const c = document.createElement('canvas');
  c.width = b.w;
  c.height = b.h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(paper, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  const img = ctx.getImageData(0, 0, b.w, b.h);
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) if (!mask[(y + b.y) * W + x + b.x]) img.data[(y * b.w + x) * 4 + 3] = 0;
  ctx.putImageData(img, 0, 0);
  return { image: c, offset: { x: b.x, y: b.y } };
}

/** Copy of the paper with the masked pixels painted over in paper colour. */
export function eraseFromPaper(input: SceneInput, masks: Uint8Array[]): HTMLCanvasElement {
  const { width: W, height: H, paper } = input;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(paper, 0, 0);
  if (!masks.length) return c;
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < W * H; i++) {
    if (masks.some((m) => m[i])) {
      img.data[i * 4] = 251;
      img.data[i * 4 + 1] = 250;
      img.data[i * 4 + 2] = 246;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Two-pass chamfer distance transform; returns the deepest point of the mask and its depth. */
export function deepestPoint(mask: Uint8Array, W: number, H: number): { point: Point; radius: number } {
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      else v = Math.min(v, 1);
      if (y > 0) {
        v = Math.min(v, d[i - W] + a);
        if (x > 0) v = Math.min(v, d[i - W - 1] + b);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + b);
      } else v = Math.min(v, 1);
      d[i] = v;
    }
  let best = 0, bi = 0;
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + a);
      else v = Math.min(v, 1);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + a);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + b);
        if (x > 0) v = Math.min(v, d[i + W - 1] + b);
      } else v = Math.min(v, 1);
      d[i] = v;
      if (v > best) {
        best = v;
        bi = i;
      }
    }
  return { point: { x: bi % W, y: Math.floor(bi / W) }, radius: best };
}

export const roleOf = (input: SceneInput, id: number) => input.analysis.bodies.find((b) => b.contourId === id);
