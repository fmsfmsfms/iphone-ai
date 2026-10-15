import { describe, expect, it } from 'vitest';

import {
  clampDuration,
  DRAG_MAX_MS,
  DRAG_MIN_MS,
  FLICK_DURATION_MS,
  flickAction,
  flickDirectionForKey,
  pointerGestureAction,
  SWIPE_REPLAY_MAX_MS,
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

  it('sends a drag as a Mirroir swipe with the user’s own points, as a quick flick (a click-drag in Long press mode)', () => {
    expect(pointerGestureAction({ mode: 'tap', from, to, travelPx: 150, elapsedMs: 180 })).toEqual({
      kind: 'swipe',
      fromX: 205,
      fromY: 600,
      toX: 205,
      toY: 300,
      durationMs: 180,
    });
    // A slow drag is replayed as a quick flick: it only runs after release, so its own pace would just add lag.
    expect(pointerGestureAction({ mode: 'double_tap', from, to, travelPx: 150, elapsedMs: 900 })).toMatchObject({ kind: 'swipe', durationMs: 300 });
    // Long press mode keeps the pointer click-drag (sliders); iOS scroll views ignore it.
    expect(pointerGestureAction({ mode: 'long_press', from, to, travelPx: 150, elapsedMs: 900 })).toMatchObject({ kind: 'drag', durationMs: 900 });
  });

  it('clamps swipes to 60–300 ms and Long press click-drags to 60–1500 ms (whole milliseconds)', () => {
    const swipe = (elapsedMs: number) => pointerGestureAction({ mode: 'tap', from, to, travelPx: 50, elapsedMs });
    const drag = (elapsedMs: number) => pointerGestureAction({ mode: 'long_press', from, to, travelPx: 50, elapsedMs });
    expect([DRAG_MIN_MS, SWIPE_REPLAY_MAX_MS, DRAG_MAX_MS]).toEqual([60, 300, 1500]);
    expect(swipe(12)).toMatchObject({ durationMs: 60 });
    expect(swipe(212.6)).toMatchObject({ durationMs: 213 });
    expect(swipe(1500)).toMatchObject({ durationMs: 300 });
    expect(swipe(Number.NaN)).toMatchObject({ durationMs: 60 });
    expect(drag(60)).toMatchObject({ kind: 'drag', durationMs: 60 });
    expect(drag(1500)).toMatchObject({ durationMs: 1500 });
    expect(drag(4200)).toMatchObject({ durationMs: 1500 });
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

  it('swipes 40% of the screen, centred, in 300 ms (ArrowUp = finger moves up = next item)', () => {
    const window = { width: 410, height: 890 };
    expect(FLICK_DURATION_MS).toBe(300);
    expect(flickAction('up', window)).toEqual({ kind: 'swipe', fromX: 205, fromY: 623, toX: 205, toY: 267, durationMs: 300 });
    expect(flickAction('down', window)).toEqual({ kind: 'swipe', fromX: 205, fromY: 267, toX: 205, toY: 623, durationMs: 300 });
    expect(flickAction('left', window)).toEqual({ kind: 'swipe', fromX: 287, fromY: 445, toX: 123, toY: 445, durationMs: 300 });
    expect(flickAction('right', window)).toEqual({ kind: 'swipe', fromX: 123, fromY: 445, toX: 287, toY: 445, durationMs: 300 });
  });

  it('works in landscape and keeps at least 60 pt from the top and bottom edges', () => {
    const landscape = flickAction('up', { width: 890, height: 410 });
    expect(landscape).toEqual({ kind: 'swipe', fromX: 445, fromY: 287, toX: 445, toY: 123, durationMs: 300 });
    // A short window: 40% would reach into the margins, so the points are pulled in.
    expect(flickAction('up', { width: 300, height: 250 })).toMatchObject({ fromY: 175, toY: 75 });
    expect(flickAction('up', { width: 300, height: 160 })).toMatchObject({ fromY: 100, toY: 60 });
    const tiny = flickAction('down', { width: 300, height: 100 });
    expect(tiny).toMatchObject({ fromY: 50, toY: 50 });
    for (const dir of ['up', 'down'] as const) {
      const a = flickAction(dir, { width: 375, height: 667 });
      expect(a && a.kind === 'swipe' ? Math.min(a.fromY, a.toY) : 0).toBeGreaterThanOrEqual(60);
      expect(a && a.kind === 'swipe' ? 667 - Math.max(a.fromY, a.toY) : 0).toBeGreaterThanOrEqual(60);
    }
  });

  it('needs a known window size', () => {
    expect(flickAction('up', null)).toBeNull();
    expect(flickAction('up', { width: 0, height: 890 })).toBeNull();
  });
});
