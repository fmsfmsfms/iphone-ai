import { describe, expect, it } from 'vitest';

import { MIRROIR_FLICK_SPEED_PT_PER_S } from '@iphone-ai/shared';

import {
  clampDuration,
  DRAG_MAX_MS,
  DRAG_MIN_MS,
  flickAction,
  flickDirection,
  flickDirectionForKey,
  FLICK_RELEASE_SPEED,
  pointerGestureAction,
  releaseVelocity,
  RELEASE_WINDOW_MS,
} from './gestures';

const from = { x: 205, y: 600 };
const to = { x: 205, y: 300 };
const phone = { width: 410, height: 890 };

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

  it('replays a drag that stopped before release with the user’s own points, at the fastest speed without momentum', () => {
    // 300 pt at 460 pt/s, whatever the user's own pace: the swipe only runs after release.
    for (const elapsedMs of [180, 900, 4000]) {
      expect(pointerGestureAction({ mode: 'tap', from, to, travelPx: 150, elapsedMs, release: { x: 0, y: 0 }, window: phone })).toEqual({
        kind: 'swipe',
        fromX: 205,
        fromY: 600,
        toX: 205,
        toY: 300,
        durationMs: 653,
      });
    }
    // Unknown release speed (no samples) is not a flick either.
    expect(pointerGestureAction({ mode: 'double_tap', from, to, travelPx: 150, elapsedMs: 900 })).toMatchObject({ kind: 'swipe', toY: 300, durationMs: 653 });
    // Long press mode keeps the pointer click-drag (sliders); iOS scroll views ignore it.
    expect(pointerGestureAction({ mode: 'long_press', from, to, travelPx: 150, elapsedMs: 900, release: { x: 0, y: -3 }, window: phone })).toMatchObject({
      kind: 'drag',
      durationMs: 900,
    });
  });

  it('pages on a flick: a drag released while moving sends the long swipe in the flick’s direction', () => {
    const flick = (release: { x: number; y: number }) => pointerGestureAction({ mode: 'tap', from, to, travelPx: 60, elapsedMs: 120, release, window: phone });
    expect(flick({ x: 0, y: -2 })).toEqual(flickAction('up', phone));
    expect(flick({ x: 0.2, y: 1.5 })).toEqual(flickAction('down', phone));
    expect(flick({ x: -0.9, y: 0.3 })).toEqual(flickAction('left', phone));
    // Just under the flick speed: the user's own points.
    expect(flick({ x: 0, y: -(FLICK_RELEASE_SPEED - 0.01) })).toMatchObject({ fromY: 600, toY: 300 });
    // Without a window size a flick still sends the user's own swipe.
    expect(pointerGestureAction({ mode: 'tap', from, to, travelPx: 60, elapsedMs: 120, release: { x: 0, y: -2 }, window: null })).toMatchObject({
      fromY: 600,
      toY: 300,
    });
  });

  it('never sends a swipe fast enough to get Mirroir’s momentum tail', () => {
    for (const [fx, fy, tx, ty] of [
      [205, 600, 205, 300],
      [205, 820, 205, 60],
      [10, 445, 400, 445],
      [205, 400, 205, 395],
    ] as const) {
      const a = pointerGestureAction({ mode: 'tap', from: { x: fx, y: fy }, to: { x: tx, y: ty }, travelPx: 50, elapsedMs: 40, release: null, window: phone });
      expect(a?.kind).toBe('swipe');
      if (a?.kind !== 'swipe') continue;
      const speed = Math.hypot(a.toX - a.fromX, a.toY - a.fromY) / ((a.durationMs ?? 0) / 1000);
      expect(speed).toBeLessThan(MIRROIR_FLICK_SPEED_PT_PER_S);
      expect(a.durationMs).toBeGreaterThanOrEqual(60);
    }
  });

  it('clamps Long press click-drags to 60–1500 ms (whole milliseconds)', () => {
    const drag = (elapsedMs: number) => pointerGestureAction({ mode: 'long_press', from, to, travelPx: 50, elapsedMs });
    expect([DRAG_MIN_MS, DRAG_MAX_MS]).toEqual([60, 1500]);
    expect(drag(12)).toMatchObject({ kind: 'drag', durationMs: 60 });
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

  it('pages with the long swipe: a one-screen flick (91%), centred, settled afterwards (ArrowUp = finger moves up = next item)', () => {
    expect(flickAction('up', phone)).toEqual({ kind: 'swipe', fromX: 205, fromY: 850, toX: 205, toY: 40, durationMs: 300, settle: true });
    expect(flickAction('down', phone)).toEqual({ kind: 'swipe', fromX: 205, fromY: 40, toX: 205, toY: 850, durationMs: 300, settle: true });
    expect(flickAction('left', phone)).toEqual({ kind: 'swipe', fromX: 392, fromY: 445, toX: 18, toY: 445, durationMs: 300, settle: true });
    expect(flickAction('right', phone)).toEqual({ kind: 'swipe', fromX: 18, fromY: 445, toX: 392, toY: 445, durationMs: 300, settle: true });
  });

  it('works in landscape and on small windows, staying inside the window', () => {
    expect(flickAction('up', { width: 890, height: 410 })).toEqual({ kind: 'swipe', fromX: 445, fromY: 392, toX: 445, toY: 18, durationMs: 300, settle: true });
    expect(flickAction('up', { width: 300, height: 250 })).toMatchObject({ fromY: 239, toY: 11 });
    expect(flickAction('up', { width: 300, height: 160 })).toMatchObject({ fromY: 153, toY: 7 });
    expect(flickAction('down', { width: 300, height: 100 })).toMatchObject({ fromY: 5, toY: 96 });
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      const a = flickAction(dir, { width: 375, height: 667 });
      if (a?.kind !== 'swipe') throw new Error('expected a swipe');
      for (const y of [a.fromY, a.toY]) expect(y > 0 && y < 667).toBe(true);
      for (const x of [a.fromX, a.toX]) expect(x > 0 && x < 375).toBe(true);
    }
  });

  it('needs a known window size', () => {
    expect(flickAction('up', null)).toBeNull();
    expect(flickAction('up', { width: 0, height: 890 })).toBeNull();
  });
});

describe('release speed', () => {
  const at = (y: number, t: number) => ({ point: { x: 205, y }, t });

  it('measures over the last RELEASE_WINDOW_MS before release', () => {
    expect(RELEASE_WINDOW_MS).toBe(100);
    // Moving up 3 pt/ms until release.
    const samples = [at(600, 0), at(540, 20), at(480, 40), at(420, 60), at(360, 80), at(300, 100)];
    expect(releaseVelocity(samples, at(270, 110))).toEqual({ x: 0, y: -3 });
    // A short gesture is measured from its first sample.
    expect(releaseVelocity([at(600, 0)], at(560, 40))).toEqual({ x: 0, y: -1 });
  });

  it('interpolates the position RELEASE_WINDOW_MS before release between sparse samples', () => {
    // Slow for 500 ms (30 pt), then fast: at t=480 the pointer was at 328.8, so 141.2 pt in the last 100 ms.
    const v = releaseVelocity([at(300, 0), at(330, 500), at(400, 540)], at(470, 580));
    expect(v!.x).toBe(0);
    expect(v!.y).toBeCloseTo(1.412, 3);
    expect(flickDirection(v)).toBe('down');
  });

  it('reads as zero when the pointer stopped before release', () => {
    const samples = [at(600, 0), at(450, 100), at(300, 200)];
    expect(releaseVelocity(samples, at(300, 600))).toEqual({ x: 0, y: 0 });
    expect(flickDirection(releaseVelocity(samples, at(300, 600)))).toBeNull();
  });

  it('needs samples and elapsed time', () => {
    expect(releaseVelocity([], at(300, 10))).toBeNull();
    expect(releaseVelocity([at(600, 50)], at(300, 50))).toBeNull();
  });

  it('flickDirection takes the dominant axis above the flick speed', () => {
    expect(FLICK_RELEASE_SPEED).toBe(0.5);
    expect(flickDirection({ x: 0, y: -0.6 })).toBe('up');
    expect(flickDirection({ x: 0.4, y: 0.45 })).toBe('down');
    expect(flickDirection({ x: 0.7, y: 0.2 })).toBe('right');
    expect(flickDirection({ x: 0.3, y: 0.3 })).toBeNull();
    expect(flickDirection(null)).toBeNull();
  });
});
