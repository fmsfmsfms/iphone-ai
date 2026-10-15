// Pure mapping from viewer input to device actions.
//
// A pointer drag on the viewer becomes Mirroir's `swipe` (a synthesized
// trackpad scroll) paced just under Mirroir's flick speed (@iphone-ai/shared
// swipe.ts): a faster swipe gets a ~1.4 s momentum tail that makes feeds creep
// and can leave TikTok stuck between two videos. A drag released while still
// moving is a flick and pages, like on the phone: it is sent as the swipe
// tool's long swipe in the flick's direction, far enough for feeds such as
// TikTok to snap to the next item. A drag that stops before release replays
// the user's own start/end points. Mirroir's `drag` is a pointer click-drag
// that iOS scroll views ignore (verified on a real iPhone), so it is only sent
// in Long press mode, for sliders and the like. A press without movement stays
// a tap (or a long-press / double-tap, per the touch mode). Arrow keys page
// like a flick.

import { pacedSwipe, swipeAction, type DeviceAction } from '@iphone-ai/shared';

import { classifyGesture, type Size, type WindowPoint } from './geometry';

export type TouchMode = 'tap' | 'long_press' | 'double_tap';

/** Long press mode click-drags: shorter ones are still sent as 60 ms (Mirroir needs a few frames). */
export const DRAG_MIN_MS = 60;
/** …and slower ones are capped so one gesture never holds the device lane for long. */
export const DRAG_MAX_MS = 1500;
export const LONG_PRESS_MIN_MS = 500;
export const LONG_PRESS_MAX_MS = 3000;

/** Release speed is measured over this last part of the drag. */
export const RELEASE_WINDOW_MS = 100;
/** A drag released at this speed or faster (window points per ms) is a flick: it pages. */
export const FLICK_RELEASE_SPEED = 0.5;

export type FlickDirection = 'up' | 'down' | 'left' | 'right';

/** Rounds and clamps a duration to Mirroir's integer milliseconds. */
export function clampDuration(ms: number, min: number, max: number): number {
  if (!Number.isFinite(ms)) return min;
  return Math.min(max, Math.max(min, Math.round(ms)));
}

export interface PointerSample {
  /** Window point (clamped to the screen). */
  point: WindowPoint;
  /** performance.now() of the pointer event. */
  t: number;
}

/**
 * Pointer velocity at release in window points per ms: the movement over the
 * last RELEASE_WINDOW_MS (the position then is interpolated between samples;
 * a shorter gesture is measured from its first sample). A pointer that stopped
 * before release has zero velocity.
 */
export function releaseVelocity(samples: readonly PointerSample[], end: PointerSample): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  const track = [...samples, end];
  const cut = end.t - RELEASE_WINDOW_MS;
  let ref = track[0]!;
  for (let i = 1; i < track.length && track[i - 1]!.t <= cut; i += 1) {
    const a = track[i - 1]!;
    const b = track[i]!;
    if (b.t <= cut) {
      ref = b;
      continue;
    }
    const f = b.t > a.t ? (cut - a.t) / (b.t - a.t) : 0;
    ref = { point: { x: a.point.x + (b.point.x - a.point.x) * f, y: a.point.y + (b.point.y - a.point.y) * f }, t: cut };
  }
  const dt = end.t - ref.t;
  if (!(dt > 0)) return null;
  return { x: (end.point.x - ref.point.x) / dt, y: (end.point.y - ref.point.y) / dt };
}

/** The direction of a flick (dominant axis), or null when the release was too slow to be one. */
export function flickDirection(velocity: { x: number; y: number } | null): FlickDirection | null {
  if (!velocity || Math.hypot(velocity.x, velocity.y) < FLICK_RELEASE_SPEED) return null;
  if (Math.abs(velocity.y) >= Math.abs(velocity.x)) return velocity.y < 0 ? 'up' : 'down';
  return velocity.x < 0 ? 'left' : 'right';
}

export interface PointerGesture {
  mode: TouchMode;
  /** Where the press started, in window points. */
  from: WindowPoint;
  /** Where it was released, in window points (clamped to the screen); null if it could not be mapped. */
  to: WindowPoint | null;
  /** Pointer travel in CSS pixels (decides tap vs. drag). */
  travelPx: number;
  /** Press duration in milliseconds. */
  elapsedMs: number;
  /** Velocity at release in window points per ms (releaseVelocity); null if unknown. */
  release?: { x: number; y: number } | null;
  /** Window size in points (needed to page on a flick). */
  window?: Size | null;
}

/** Turns a finished pointer gesture into the device action to send (null when there is nothing to send). */
export function pointerGestureAction(gesture: PointerGesture): DeviceAction | null {
  const { from, to, mode, elapsedMs } = gesture;
  if (classifyGesture(gesture.travelPx) === 'tap') {
    if (mode === 'long_press') {
      return { kind: 'long_press', x: from.x, y: from.y, durationMs: clampDuration(elapsedMs, LONG_PRESS_MIN_MS, LONG_PRESS_MAX_MS) };
    }
    if (mode === 'double_tap') return { kind: 'double_tap', x: from.x, y: from.y };
    return { kind: 'tap', x: from.x, y: from.y };
  }
  if (mode === 'long_press') {
    if (!to) return null;
    return { kind: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: clampDuration(elapsedMs, DRAG_MIN_MS, DRAG_MAX_MS) };
  }
  const flick = flickDirection(gesture.release ?? null);
  const page = flick ? flickAction(flick, gesture.window) : null;
  if (page) return page;
  if (!to) return null;
  return pacedSwipe(from.x, from.y, to.x, to.y);
}

/** Arrow key → flick direction (the finger's direction: ArrowUp flicks up, i.e. to the next item). */
export function flickDirectionForKey(key: string): FlickDirection | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

/**
 * A page swipe: the swipe tool's long swipe (70% of the screen, centred,
 * paced without momentum). `window` is the Mirroir window size in points;
 * returns null when it is unknown.
 */
export function flickAction(direction: FlickDirection, window: Size | null | undefined): DeviceAction | null {
  if (!window || !(window.width > 0 && window.height > 0)) return null;
  return swipeAction(direction, 'long', window.width, window.height);
}
