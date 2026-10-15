// Swipes shared by the AI swipe tool, workflow swipe steps and the Live viewer.
//
// Mirroir's `swipe` is a synthesized trackpad scroll. Measured on the real
// iPhone (TikTok For You, 2026-10-15):
// - iOS snaps a paging feed to the nearest item only when a scroll ends with a
//   slow lift. At MIRROIR_FLICK_SPEED or faster Mirroir adds a ~1.4 s decaying
//   momentum tail (≈2.3 s per call); iOS moves the content with it and stops
//   wherever it ends, so a flick can leave TikTok stuck between two videos.
//   Replaying a real two-finger flick recorded from the trackpad did the same.
// - A slower drag has no tail and ends with a slow lift, but the content crawls
//   with it for over a second and TikTok snapped back about one time in three.
// - A small slow nudge after a stranded scroll snapped it onto the nearest
//   video every time.
// So paging (`long`) is a flick sized to travel one screen — it moves fast and
// lands at or near the next item — followed by a settle nudge in the same
// direction (`settle`, sent by the device controller): 5 of 5 pages landed
// cleanly, ≈2.9 s per page. `short` and `medium` scroll lists: paced just under
// the flick speed, no tail, exactly that far. Mirroir's `drag` is no
// substitute: iPhone Mirroring delivers it as a pointer click-drag, which iOS
// scroll views ignore.

import type { SwipeDirection } from './control.js';

export type SwipeDistance = 'short' | 'medium' | 'long';

/** Mirroir gives a swipe a momentum tail at this speed or faster (pt/s, window points). */
export const MIRROIR_FLICK_SPEED_PT_PER_S = 500;
/** Scrolling swipes (short, medium, slow viewer drags) move at this speed: as fast as Mirroir goes without a momentum tail. */
export const SWIPE_SPEED_PT_PER_S = 460;
/** Shortest swipe sent (Mirroir needs a few frames). */
export const SWIPE_MIN_DURATION_MS = 60;
/**
 * Finger travel as a fraction of the screen dimension along the swipe. `long`
 * is the page flick: with its momentum tail, 91% of the finger travel moved
 * TikTok one screen (711 of 782 pt).
 */
export const SWIPE_TRAVEL: Readonly<Record<SwipeDistance, number>> = { short: 0.25, medium: 0.45, long: 0.91 };
/** The page flick's duration: fast enough for Mirroir's momentum tail (its calibrated default). */
export const PAGE_FLICK_DURATION_MS = 300;
/** Scrolling swipe end points stay this far from the top and bottom edges. */
export const SWIPE_MARGIN_Y = 60;
/** …and this far from the side edges. */
export const SWIPE_MARGIN_X = 24;
/** The settle nudge after a page flick: this far, centred, in the same direction… */
export const SETTLE_NUDGE_PT = 20;
/** …this slowly, so it ends with the slow lift that makes iOS snap. */
export const SETTLE_NUDGE_MS = 200;

export type SwipeAction = { kind: 'swipe'; fromX: number; fromY: number; toX: number; toY: number; durationMs: number; settle?: boolean };

/** Duration that moves `distancePt` at SWIPE_SPEED_PT_PER_S (rounded up, so the speed never exceeds it). */
export function swipeDurationMs(distancePt: number): number {
  if (!Number.isFinite(distancePt) || distancePt <= 0) return SWIPE_MIN_DURATION_MS;
  return Math.max(SWIPE_MIN_DURATION_MS, Math.ceil((distancePt / SWIPE_SPEED_PT_PER_S) * 1000));
}

/** A scrolling swipe between two window points, paced to SWIPE_SPEED_PT_PER_S. */
export function pacedSwipe(fromX: number, fromY: number, toX: number, toY: number): SwipeAction {
  return { kind: 'swipe', fromX, fromY, toX, toY, durationMs: swipeDurationMs(Math.hypot(toX - fromX, toY - fromY)) };
}

/**
 * A swipe across the middle of the screen in the finger's `direction` ('up'
 * scrolls the page down: the next video in TikTok, Reels or Shorts).
 * `long` is the page flick (settled afterwards by the device controller);
 * `short`/`medium` are paced scrolls kept clear of the edges. `width`/`height`
 * are the window size in points.
 */
export function swipeAction(direction: SwipeDirection, distance: SwipeDistance, width: number, height: number): SwipeAction {
  const page = distance === 'long';
  const travel = SWIPE_TRAVEL[distance];
  // Mirroir posts the scroll at the middle of the window; the end points only
  // set its length, so the page flick may come closer to the edges.
  const clamp = (value: number, size: number, margin: number) => {
    const low = Math.min(margin, size / 2);
    const high = Math.max(size - margin, size / 2);
    return Math.round(Math.min(high, Math.max(low, value)));
  };
  const cx = width / 2;
  const cy = height / 2;
  const halfX = (width * travel) / 2;
  const halfY = (height * travel) / 2;
  const x = (value: number) => clamp(value, width, page ? 1 : SWIPE_MARGIN_X);
  const y = (value: number) => clamp(value, height, page ? 1 : SWIPE_MARGIN_Y);
  const make = (fromX: number, fromY: number, toX: number, toY: number): SwipeAction =>
    page ? { kind: 'swipe', fromX, fromY, toX, toY, durationMs: PAGE_FLICK_DURATION_MS, settle: true } : pacedSwipe(fromX, fromY, toX, toY);
  switch (direction) {
    case 'up':
      return make(x(cx), y(cy + halfY), x(cx), y(cy - halfY));
    case 'down':
      return make(x(cx), y(cy - halfY), x(cx), y(cy + halfY));
    case 'left':
      return make(x(cx + halfX), y(cy), x(cx - halfX), y(cy));
    case 'right':
      return make(x(cx - halfX), y(cy), x(cx + halfX), y(cy));
  }
}

/**
 * The settle nudge that follows a page flick: SETTLE_NUDGE_PT through the
 * middle of the window in the flick's direction, at SETTLE_NUDGE_MS. It ends
 * with a slow lift, so iOS snaps the feed to the nearest item; a feed that
 * already snapped moves a few points and snaps back. Null for a swipe with no
 * direction or an unknown window size.
 */
export function settleNudge(swipe: { fromX: number; fromY: number; toX: number; toY: number }, width: number, height: number): SwipeAction | null {
  const dx = swipe.toX - swipe.fromX;
  const dy = swipe.toY - swipe.fromY;
  const length = Math.hypot(dx, dy);
  if (!(length > 0) || !(width > 0 && height > 0)) return null;
  const half = SETTLE_NUDGE_PT / 2;
  const ux = (dx / length) * half;
  const uy = (dy / length) * half;
  const cx = width / 2;
  const cy = height / 2;
  const r = (value: number) => Math.round(value * 10) / 10;
  return { kind: 'swipe', fromX: r(cx - ux), fromY: r(cy - uy), toX: r(cx + ux), toY: r(cy + uy), durationMs: SETTLE_NUDGE_MS };
}
