// What a coordinate tap may hit. OCR reports text centres only (no bounds), so
// "the nearest label within 40 pt" misses taps on the right side of a
// full-width list row or the edge of a wide button. Every label the tap could
// plausibly land on is returned so the policy can check each one.

import type { ScreenElement } from '@iphone-ai/shared';

export interface PointTargets {
  /** Nearest label within `radius` (what the tap most likely hits), if any. */
  primary: string | null;
  /**
   * Every label the tap may hit: all labels within `radius` (nearest first);
   * when there are none, every label on the same row band (iOS rows and wide
   * buttons span the full width).
   */
  candidates: string[];
  /** Labels within `nearbyRadius` of a point that hit nothing else (approval hints only). */
  nearby: string[];
}

export interface PointTargetOptions {
  radius?: number;
  rowHalfHeight?: number;
  nearbyRadius?: number;
}

export function labelsAtPoint(
  elements: readonly ScreenElement[],
  x: number,
  y: number,
  { radius = 40, rowHalfHeight = 22, nearbyRadius = 80 }: PointTargetOptions = {},
): PointTargets {
  const labelled = elements
    .filter((e) => e.label.trim())
    .map((e) => ({ e, d: Math.hypot(e.x - x, e.y - y) }))
    .sort((a, b) => a.d - b.d);
  const within = labelled.filter((c) => c.d <= radius).map((c) => c.e.label);
  if (within.length > 0) return { primary: within[0]!, candidates: unique(within), nearby: [] };
  // Fallback only: on the Home Screen a row band would pull in every icon of the grid row.
  const row = labelled
    .filter((c) => Math.abs(c.e.y - y) <= rowHalfHeight)
    .sort((a, b) => Math.abs(a.e.x - x) - Math.abs(b.e.x - x))
    .map((c) => c.e.label);
  if (row.length > 0) return { primary: null, candidates: unique(row), nearby: [] };
  return { primary: null, candidates: [], nearby: unique(labelled.filter((c) => c.d <= nearbyRadius).map((c) => c.e.label)) };
}

function unique(labels: readonly string[]): string[] {
  return [...new Set(labels)];
}
