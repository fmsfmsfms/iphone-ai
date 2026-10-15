// Swipe pacing shared by the AI swipe tool, workflow swipe steps and the Live
// viewer.
//
// Mirroir's `swipe` is a synthesized trackpad scroll. At MIRROIR_FLICK_SPEED or
// faster it is a flick: after the "finger" lifts, Mirroir plays a ~1.4 s
// decaying momentum tail and only returns once it ends (≈2.3 s per swipe). On
// the real iPhone (2026-10-15) that tail made TikTok creep, and a 600 pt flick
// left the feed stuck half-way between two videos until the next input.
// Slower than that there is no tail: iOS sees a drag that ends with a lift,
// the feed snaps to the nearest page at once, and Mirroir returns right after
// the lift (a 521 pt swipe took 1.6 s and had settled when it returned).
// TikTok snapped back at 400 pt and paged from 450 pt (of 782), so paging
// swipes travel 70% of the screen. Mirroir's `drag` is no substitute: iPhone
// Mirroring delivers it as a pointer click-drag, which iOS scroll views ignore.

import type { SwipeDirection } from './control.js';

export type SwipeDistance = 'short' | 'medium' | 'long';

/** Mirroir gives a swipe a momentum tail at this speed or faster (pt/s, window points). */
export const MIRROIR_FLICK_SPEED_PT_PER_S = 500;
/** Every swipe moves at this speed: as fast as Mirroir goes without a momentum tail. */
export const SWIPE_SPEED_PT_PER_S = 460;
/** Shortest swipe sent (Mirroir needs a few frames). */
export const SWIPE_MIN_DURATION_MS = 60;
/** Finger travel as a fraction of the screen dimension along the swipe; `long` pages feeds. */
export const SWIPE_TRAVEL: Readonly<Record<SwipeDistance, number>> = { short: 0.25, medium: 0.45, long: 0.7 };
/** Swipe end points stay this far from the top and bottom edges (status bar, Home indicator). */
export const SWIPE_MARGIN_Y = 60;
/** …and this far from the side edges. */
export const SWIPE_MARGIN_X = 24;

export type SwipeAction = { kind: 'swipe'; fromX: number; fromY: number; toX: number; toY: number; durationMs: number };

/** Duration that moves `distancePt` at SWIPE_SPEED_PT_PER_S (rounded up, so the speed never exceeds it). */
export function swipeDurationMs(distancePt: number): number {
  if (!Number.isFinite(distancePt) || distancePt <= 0) return SWIPE_MIN_DURATION_MS;
  return Math.max(SWIPE_MIN_DURATION_MS, Math.ceil((distancePt / SWIPE_SPEED_PT_PER_S) * 1000));
}

/** A swipe between two window points, paced to SWIPE_SPEED_PT_PER_S. */
export function pacedSwipe(fromX: number, fromY: number, toX: number, toY: number): SwipeAction {
  return { kind: 'swipe', fromX, fromY, toX, toY, durationMs: swipeDurationMs(Math.hypot(toX - fromX, toY - fromY)) };
}

/**
 * A swipe across the middle of the screen in the finger's `direction` ('up'
 * scrolls the page down: the next video in TikTok, Reels or Shorts), with
 * `distance` travel kept clear of the edges. `width`/`height` are the window
 * size in points.
 */
export function swipeAction(direction: SwipeDirection, distance: SwipeDistance, width: number, height: number): SwipeAction {
  const travel = SWIPE_TRAVEL[distance];
  const clamp = (value: number, size: number, margin: number) => {
    const low = Math.min(margin, size / 2);
    const high = Math.max(size - margin, size / 2);
    return Math.round(Math.min(high, Math.max(low, value)));
  };
  const cx = width / 2;
  const cy = height / 2;
  const halfX = (width * travel) / 2;
  const halfY = (height * travel) / 2;
  const x = (value: number) => clamp(value, width, SWIPE_MARGIN_X);
  const y = (value: number) => clamp(value, height, SWIPE_MARGIN_Y);
  switch (direction) {
    case 'up':
      return pacedSwipe(x(cx), y(cy + halfY), x(cx), y(cy - halfY));
    case 'down':
      return pacedSwipe(x(cx), y(cy - halfY), x(cx), y(cy + halfY));
    case 'left':
      return pacedSwipe(x(cx + halfX), y(cy), x(cx - halfX), y(cy));
    case 'right':
      return pacedSwipe(x(cx - halfX), y(cy), x(cx + halfX), y(cy));
  }
}
