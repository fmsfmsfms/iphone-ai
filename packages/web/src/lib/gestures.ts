// Pure mapping from viewer input to device actions.
//
// A pointer drag on the viewer becomes Mirroir's `swipe` (a synthesized
// trackpad scroll) with the user's own start/end points and the gesture's real
// duration: Mirroir gives a fast flick a momentum tail, which is what pages
// feeds such as TikTok, and a slow drag scrolls without inertia. Mirroir's
// `drag` is a pointer click-drag that iOS scroll views ignore (verified on a
// real iPhone), so it is only sent in Long press mode, for sliders and the
// like. A press without movement stays a tap (or a long-press / double-tap,
// per the touch mode). Arrow keys send centred swipes.

import type { DeviceAction } from '@iphone-ai/shared';

import { classifyGesture, roundTo, type Size, type WindowPoint } from './geometry';

export type TouchMode = 'tap' | 'long_press' | 'double_tap';

/** A swipe or drag shorter than this is still sent as 60 ms (Mirroir needs a few frames). */
export const DRAG_MIN_MS = 60;
/**
 * A swipe is replayed after the pointer is released, so replaying a slow drag
 * at its own speed only adds lag: swipes are sent as quick flicks (Mirroir's
 * default duration, which gets momentum and pages feeds) in the user's
 * direction and distance.
 */
export const SWIPE_REPLAY_MAX_MS = 300;
/** Slower gestures are capped so one gesture never holds the device lane for long. */
export const DRAG_MAX_MS = 1500;
export const LONG_PRESS_MIN_MS = 500;
export const LONG_PRESS_MAX_MS = 3000;

/** Keyboard flicks: swipe this fraction of the screen, centred, in FLICK_DURATION_MS (Mirroir's default, with momentum). */
export const FLICK_FRACTION = 0.4;
export const FLICK_DURATION_MS = 300;
/** Flicks stay at least this far (points) from the screen edges (Home indicator, status bar, back gesture). */
export const FLICK_EDGE_MARGIN_PT = 60;

export type FlickDirection = 'up' | 'down' | 'left' | 'right';

/** Rounds and clamps a duration to Mirroir's integer milliseconds. */
export function clampDuration(ms: number, min: number, max: number): number {
  if (!Number.isFinite(ms)) return min;
  return Math.min(max, Math.max(min, Math.round(ms)));
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
  if (!to) return null;
  return {
    kind: mode === 'long_press' ? 'drag' : 'swipe',
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    durationMs: clampDuration(elapsedMs, DRAG_MIN_MS, mode === 'long_press' ? DRAG_MAX_MS : SWIPE_REPLAY_MAX_MS),
  };
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

function clampToScreen(value: number, length: number): number {
  const center = length / 2;
  const min = Math.min(FLICK_EDGE_MARGIN_PT, center);
  const max = Math.max(length - FLICK_EDGE_MARGIN_PT, center);
  return roundTo(Math.min(max, Math.max(min, value)), 1);
}

/**
 * A swipe with flick momentum across ~40% of the screen, centred, in 300 ms.
 * `window` is the Mirroir window size in points; returns null when it is unknown.
 */
export function flickAction(direction: FlickDirection, window: Size | null | undefined): DeviceAction | null {
  if (!window || !(window.width > 0 && window.height > 0)) return null;
  const cx = window.width / 2;
  const cy = window.height / 2;
  const halfX = (window.width * FLICK_FRACTION) / 2;
  const halfY = (window.height * FLICK_FRACTION) / 2;
  let from: WindowPoint;
  let to: WindowPoint;
  switch (direction) {
    case 'up':
      from = { x: cx, y: cy + halfY };
      to = { x: cx, y: cy - halfY };
      break;
    case 'down':
      from = { x: cx, y: cy - halfY };
      to = { x: cx, y: cy + halfY };
      break;
    case 'left':
      from = { x: cx + halfX, y: cy };
      to = { x: cx - halfX, y: cy };
      break;
    case 'right':
      from = { x: cx - halfX, y: cy };
      to = { x: cx + halfX, y: cy };
      break;
  }
  return {
    kind: 'swipe',
    fromX: clampToScreen(from.x, window.width),
    fromY: clampToScreen(from.y, window.height),
    toX: clampToScreen(to.x, window.width),
    toY: clampToScreen(to.y, window.height),
    durationMs: FLICK_DURATION_MS,
  };
}
