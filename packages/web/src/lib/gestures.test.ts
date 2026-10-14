import { describe, expect, it } from 'vitest';

import {
  clampDuration,
  DRAG_MAX_MS,
  DRAG_MIN_MS,
  FLICK_DURATION_MS,
  flickAction,
  flickDirectionForKey,
  pointerGestureAction,
} from './gestures';

const from = { x: 205, y: 600 };
const to = { x: 205, y: 300 };

describe('pointerGestureAction', () => {
  it('keeps a press without movement a tap, long-press or double-tap per the mode', () => {
    expect(pointerGestureAction({ mode: 'tap', from, to: from, travelPx: 3, elapsedMs: 90 })).toEqual({ kind: 'tap', x: 205, y: 600 });
    expect(pointerGestureAction({ mode: 'double_tap', from, to: from, travelPx: 0, elapsedMs: 90 })).toEqual({ kind: 'double_tap', x: 205, y: 600 });
    expect(pointerGestureAction({ mode: 'long_press', from, to: from, travelPx: 8, elapsedMs: 120 })).toEqual({
      kind: 'long_press',
      x: 205,
      y: 600,
      durationMs: 500,
    });
    expect(pointerGestureAction({ mode: 'long_press', from, to: from, travelPx: 2, elapsedMs: 9000 })).toMatchObject({ durationMs: 3000 });
  });

  it('sends every drag — quick or slow — as a real touch drag with the user’s own points', () => {
    expect(pointerGestureAction({ mode: 'tap', from, to, travelPx: 150, elapsedMs: 180 })).toEqual({
      kind: 'drag',
      fromX: 205,
      fromY: 600,
      toX: 205,
      toY: 300,
      durationMs: 180,
    });
    // Slow drags are drags too (no trackpad-scroll "swipe" from the viewer), whatever the touch mode.
    expect(pointerGestureAction({ mode: 'long_press', from, to, travelPx: 150, elapsedMs: 900 })).toMatchObject({ kind: 'drag', durationMs: 900 });
    expect(pointerGestureAction({ mode: 'double_tap', from, to, travelPx: 150, elapsedMs: 700 })).toMatchObject({ kind: 'drag' });
  });

  it('clamps the drag duration to 60–1500 ms (whole milliseconds)', () => {
    const drag = (elapsedMs: number) => pointerGestureAction({ mode: 'tap', from, to, travelPx: 50, elapsedMs });
    expect([DRAG_MIN_MS, DRAG_MAX_MS]).toEqual([60, 1500]);
    expect(drag(12)).toMatchObject({ durationMs: 60 });
    expect(drag(60)).toMatchObject({ durationMs: 60 });
    expect(drag(212.6)).toMatchObject({ durationMs: 213 });
    expect(drag(1500)).toMatchObject({ durationMs: 1500 });
    expect(drag(4200)).toMatchObject({ durationMs: 1500 });
    expect(drag(Number.NaN)).toMatchObject({ durationMs: 60 });
  });

  it('sends nothing for a drag whose end could not be mapped', () => {
    expect(pointerGestureAction({ mode: 'tap', from, to: null, travelPx: 50, elapsedMs: 200 })).toBeNull();
  });

  it('clampDuration rounds and bounds', () => {
    expect(clampDuration(59.4, 60, 1500)).toBe(60);
    expect(clampDuration(1499.6, 60, 1500)).toBe(1500);
    expect(clampDuration(Number.POSITIVE_INFINITY, 60, 1500)).toBe(60);
  });
});

describe('keyboard flicks', () => {
  it('maps arrow keys to flick directions', () => {
    expect(flickDirectionForKey('ArrowUp')).toBe('up');
    expect(flickDirectionForKey('ArrowDown')).toBe('down');
    expect(flickDirectionForKey('ArrowLeft')).toBe('left');
    expect(flickDirectionForKey('ArrowRight')).toBe('right');
    expect(flickDirectionForKey('Enter')).toBeNull();
    expect(flickDirectionForKey('w')).toBeNull();
  });

  it('flicks 40% of the screen, centred, in 200 ms (ArrowUp = finger moves up = next item)', () => {
    const window = { width: 410, height: 890 };
    expect(FLICK_DURATION_MS).toBe(200);
    expect(flickAction('up', window)).toEqual({ kind: 'drag', fromX: 205, fromY: 623, toX: 205, toY: 267, durationMs: 200 });
    expect(flickAction('down', window)).toEqual({ kind: 'drag', fromX: 205, fromY: 267, toX: 205, toY: 623, durationMs: 200 });
    expect(flickAction('left', window)).toEqual({ kind: 'drag', fromX: 287, fromY: 445, toX: 123, toY: 445, durationMs: 200 });
    expect(flickAction('right', window)).toEqual({ kind: 'drag', fromX: 123, fromY: 445, toX: 287, toY: 445, durationMs: 200 });
  });

  it('works in landscape and keeps at least 60 pt from the top and bottom edges', () => {
    const landscape = flickAction('up', { width: 890, height: 410 });
    expect(landscape).toEqual({ kind: 'drag', fromX: 445, fromY: 287, toX: 445, toY: 123, durationMs: 200 });
    // A short window: 40% would reach into the margins, so the points are pulled in.
    expect(flickAction('up', { width: 300, height: 250 })).toMatchObject({ fromY: 175, toY: 75 });
    expect(flickAction('up', { width: 300, height: 160 })).toMatchObject({ fromY: 100, toY: 60 });
    const tiny = flickAction('down', { width: 300, height: 100 });
    expect(tiny).toMatchObject({ fromY: 50, toY: 50 });
    for (const dir of ['up', 'down'] as const) {
      const a = flickAction(dir, { width: 375, height: 667 });
      expect(a && a.kind === 'drag' ? Math.min(a.fromY, a.toY) : 0).toBeGreaterThanOrEqual(60);
      expect(a && a.kind === 'drag' ? 667 - Math.max(a.fromY, a.toY) : 0).toBeGreaterThanOrEqual(60);
    }
  });

  it('needs a known window size', () => {
    expect(flickAction('up', null)).toBeNull();
    expect(flickAction('up', { width: 0, height: 890 })).toBeNull();
  });
});
