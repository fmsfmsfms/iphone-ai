import { describe, expect, it } from 'vitest';

import {
  classifyGesture,
  contentBox,
  fitAspect,
  pointerToWindowPoint,
  roundTo,
  windowPointToElement,
} from './geometry';

describe('contentBox', () => {
  it('fills the element when aspect ratios match', () => {
    expect(contentBox({ width: 410, height: 890 }, { width: 820, height: 1780 })).toEqual({
      offsetX: 0,
      offsetY: 0,
      width: 410,
      height: 890,
    });
  });

  it('letterboxes a portrait bitmap in a square box', () => {
    const box = contentBox({ width: 600, height: 600 }, { width: 820, height: 1780 });
    expect(box).not.toBeNull();
    expect(box!.height).toBeCloseTo(600, 6);
    expect(box!.width).toBeCloseTo((820 * 600) / 1780, 6);
    expect(box!.offsetX).toBeCloseTo((600 - box!.width) / 2, 6);
    expect(box!.offsetY).toBe(0);
  });

  it('returns null for empty sizes', () => {
    expect(contentBox({ width: 0, height: 100 }, { width: 10, height: 10 })).toBeNull();
    expect(contentBox({ width: 100, height: 100 }, { width: 0, height: 10 })).toBeNull();
  });
});

describe('pointerToWindowPoint', () => {
  it('maps a portrait 2x frame rendered at 1 CSS px per point', () => {
    const point = pointerToWindowPoint({
      clientX: 100 + 205,
      clientY: 50 + 445,
      rect: { left: 100, top: 50, width: 410, height: 890 },
      natural: { width: 820, height: 1780 },
      pxPerPt: 2,
    });
    expect(point).toEqual({ x: 205, y: 445 });
  });

  it('maps the top-left corner to (0, 0) and the bottom-right corner to the window size', () => {
    const base = {
      rect: { left: 10, top: 20, width: 410, height: 890 },
      natural: { width: 820, height: 1780 },
      pxPerPt: 2,
      windowPt: { width: 410, height: 890 },
    };
    expect(pointerToWindowPoint({ ...base, clientX: 10, clientY: 20 })).toEqual({ x: 0, y: 0 });
    expect(pointerToWindowPoint({ ...base, clientX: 420, clientY: 910 })).toEqual({ x: 410, y: 890 });
  });

  it('maps a landscape 2x frame rendered at half size', () => {
    const point = pointerToWindowPoint({
      clientX: 222.5,
      clientY: 102.5,
      rect: { left: 0, top: 0, width: 445, height: 205 },
      natural: { width: 1780, height: 820 },
      pxPerPt: 2,
    });
    expect(point).toEqual({ x: 445, y: 205 });
  });

  it('maps a 1x frame shown with CSS zoom', () => {
    // 410×890 pt window captured at 1 px/pt, displayed at 2× (820×1780 CSS px).
    const point = pointerToWindowPoint({
      clientX: 410,
      clientY: 890,
      rect: { left: 0, top: 0, width: 820, height: 1780 },
      natural: { width: 410, height: 890 },
      pxPerPt: 1,
    });
    expect(point).toEqual({ x: 205, y: 445 });
  });

  it('maps a 3x frame', () => {
    const point = pointerToWindowPoint({
      clientX: 393 / 2,
      clientY: 852 / 2,
      rect: { left: 0, top: 0, width: 393, height: 852 },
      natural: { width: 1179, height: 2556 },
      pxPerPt: 3,
    });
    expect(point).toEqual({ x: 196.5, y: 426 });
  });

  it('removes object-fit: contain letterboxing', () => {
    const rect = { left: 0, top: 0, width: 600, height: 600 };
    const natural = { width: 820, height: 1780 };
    const box = contentBox(rect, natural)!;
    const center = pointerToWindowPoint({
      clientX: box.offsetX + box.width / 2,
      clientY: 300,
      rect,
      natural,
      pxPerPt: 2,
    });
    expect(center).toEqual({ x: 205, y: 445 });
    const topLeft = pointerToWindowPoint({ clientX: box.offsetX, clientY: 0, rect, natural, pxPerPt: 2 });
    expect(topLeft).toEqual({ x: 0, y: 0 });
  });

  it('rejects positions in the letterbox bars and outside the element', () => {
    const rect = { left: 0, top: 0, width: 600, height: 600 };
    const natural = { width: 820, height: 1780 };
    expect(pointerToWindowPoint({ clientX: 20, clientY: 300, rect, natural, pxPerPt: 2 })).toBeNull();
    expect(pointerToWindowPoint({ clientX: 590, clientY: 300, rect, natural, pxPerPt: 2 })).toBeNull();
    expect(pointerToWindowPoint({ clientX: 300, clientY: -1, rect, natural, pxPerPt: 2 })).toBeNull();
    expect(pointerToWindowPoint({ clientX: 300, clientY: 601, rect, natural, pxPerPt: 2 })).toBeNull();
  });

  it('clamps out-of-bounds positions to the nearest edge when asked', () => {
    const point = pointerToWindowPoint({
      clientX: -50,
      clientY: 2000,
      rect: { left: 0, top: 0, width: 410, height: 890 },
      natural: { width: 820, height: 1780 },
      pxPerPt: 2,
      clamp: true,
    });
    expect(point).toEqual({ x: 0, y: 890 });
  });

  it('rounds to one decimal place by default and honours precision', () => {
    const input = {
      clientX: 123.4567,
      clientY: 77.7777,
      rect: { left: 0, top: 0, width: 410, height: 890 },
      natural: { width: 820, height: 1780 },
      pxPerPt: 2,
    };
    expect(pointerToWindowPoint(input)).toEqual({ x: 123.5, y: 77.8 });
    expect(pointerToWindowPoint({ ...input, precision: 0 })).toEqual({ x: 123, y: 78 });
  });

  it('clamps to the window size reported in points', () => {
    // Bitmap is one pixel wider than 2 × width (rounding at capture time).
    const point = pointerToWindowPoint({
      clientX: 411,
      clientY: 10,
      rect: { left: 0, top: 0, width: 411, height: 890 },
      natural: { width: 822, height: 1780 },
      pxPerPt: 2,
      windowPt: { width: 410, height: 890 },
    });
    expect(point).toEqual({ x: 410, y: 10 });
  });

  it('returns null for invalid scale factors or sizes', () => {
    const rect = { left: 0, top: 0, width: 410, height: 890 };
    const natural = { width: 820, height: 1780 };
    expect(pointerToWindowPoint({ clientX: 1, clientY: 1, rect, natural, pxPerPt: 0 })).toBeNull();
    expect(pointerToWindowPoint({ clientX: 1, clientY: 1, rect, natural, pxPerPt: Number.NaN })).toBeNull();
    expect(pointerToWindowPoint({ clientX: 1, clientY: 1, rect: { ...rect, width: 0 }, natural, pxPerPt: 2 })).toBeNull();
  });

  it('round-trips with windowPointToElement', () => {
    const rect = { left: 0, top: 0, width: 300, height: 700 };
    const natural = { width: 820, height: 1780 };
    const el = windowPointToElement({ x: 100, y: 300 }, rect, natural, 2)!;
    expect(pointerToWindowPoint({ clientX: el.x, clientY: el.y, rect, natural, pxPerPt: 2 })).toEqual({ x: 100, y: 300 });
  });
});

describe('helpers', () => {
  it('roundTo avoids negative zero', () => {
    expect(Object.is(roundTo(-0.01, 1), 0)).toBe(true);
    expect(roundTo(1.25, 1)).toBe(1.3);
  });

  it('fitAspect fits by width or height', () => {
    expect(fitAspect({ width: 400, height: 1000 }, 0.5)).toEqual({ width: 400, height: 800 });
    expect(fitAspect({ width: 400, height: 400 }, 0.5)).toEqual({ width: 200, height: 400 });
    expect(fitAspect({ width: 0, height: 400 }, 0.5)).toEqual({ width: 0, height: 0 });
  });

  it('classifyGesture distinguishes a tap from a drag by travel only', () => {
    expect(classifyGesture(3)).toBe('tap');
    expect(classifyGesture(8)).toBe('tap');
    expect(classifyGesture(8.5)).toBe('drag');
    expect(classifyGesture(40)).toBe('drag');
  });
});
