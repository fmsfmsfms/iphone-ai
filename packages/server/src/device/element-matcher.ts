// Port of Mirroir's ElementMatcher (Sources/mirroir-mcp/ElementMatcher.swift):
// exact → case-insensitive → diacritic-insensitive → substring → reverse
// substring (minimum length max(3, ⌈label/2⌉)). First element in reading order wins.

import type { ScreenElement } from '@iphone-ai/shared';

export type MatchStrategy = 'exact' | 'case-insensitive' | 'diacritic-insensitive' | 'substring' | 'reverse-substring';

export interface ElementMatch {
  element: ScreenElement;
  strategy: MatchStrategy;
}

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchElement(
  elements: readonly ScreenElement[],
  label: string,
  options: { exactOnly?: boolean } = {},
): ElementMatch | null {
  const candidates = elements.filter((e) => e.label.trim().length > 0);
  const target = label.trim();
  if (!target) return null;

  const exact = candidates.find((e) => e.label.trim() === target);
  if (exact) return { element: exact, strategy: 'exact' };
  if (options.exactOnly) return null;

  const lower = target.toLowerCase();
  const ci = candidates.find((e) => e.label.trim().toLowerCase() === lower);
  if (ci) return { element: ci, strategy: 'case-insensitive' };

  const folded = fold(target);
  const di = candidates.find((e) => fold(e.label) === folded);
  if (di) return { element: di, strategy: 'diacritic-insensitive' };

  const sub = candidates.find((e) => fold(e.label).includes(folded));
  if (sub) return { element: sub, strategy: 'substring' };

  const minLength = Math.max(3, Math.ceil(folded.length / 2));
  const rev = candidates.find((e) => {
    const f = fold(e.label);
    return f.length >= minLength && folded.includes(f);
  });
  if (rev) return { element: rev, strategy: 'reverse-substring' };

  return null;
}

/** True when `label` is visible (any strategy). */
export function isVisible(elements: readonly ScreenElement[], label: string): boolean {
  return matchElement(elements, label) !== null;
}
