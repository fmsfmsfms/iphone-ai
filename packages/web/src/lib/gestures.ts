// Pure mapping from viewer input to device actions.
//
// Mirroir's `swipe` is a synthesized trackpad scroll with a long momentum tail
// (~2.3 s per swipe on a real device); its `drag` is a real touch drag (mouse
// down → dragged frames over `duration_ms` → up, no initial hold), which iOS
// treats like a finger. So every pointer drag on the viewer — a quick flick or
// a slow drag — becomes a `drag` with the user's own start/end points and the
// gesture's real duration. A press without movement stays a tap (or a
// long-press / double-tap, per the touch mode). Arrow keys send centred flicks.

import type { DeviceAction } from '@iphone-ai/shared';

import { classifyGesture, roundTo, type Size, type WindowPoint } from './geometry';

export type TouchMode = 'tap' | 'long_press' | 'double_tap';

/** A drag shorter than this is still sent as a 60 ms flick (Mirroir needs a few dragged frames). */
export const DRAG_MIN_MS = 60;
/** Slower drags are capped so one gesture never holds the device lane for long. */
export const DRAG_MAX_MS = 1500;
export const LONG_PRESS_MIN_MS = 500;
export const LONG_PRESS_MAX_MS = 3000;

/** Keyboard flicks: drag this fraction of the screen, centred, in FLICK_DURATION_MS. */
export const FLICK_FRACTION = 0.4;
export const FLICK_DURATION_MS = 200;
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
    kind: 'drag',
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    durationMs: clampDuration(elapsedMs, DRAG_MIN_MS, DRAG_MAX_MS),
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
 * A finger flick across ~40% of the screen, centred, in 200 ms. `window` is the
 * Mirroir window size in points; returns null when it is unknown.
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
    kind: 'drag',
    fromX: clampToScreen(from.x, window.width),
    fromY: clampToScreen(from.y, window.height),
    toX: clampToScreen(to.x, window.width),
    toY: clampToScreen(to.y, window.height),
    durationMs: FLICK_DURATION_MS,
  };
}
