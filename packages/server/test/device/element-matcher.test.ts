// Port of Mirroir's ElementMatcher: exact → case-insensitive →
// diacritic-insensitive → substring → reverse substring; first element in
// reading order wins within each tier.

import { describe, expect, it } from 'vitest';

import type { ScreenElement } from '@iphone-ai/shared';

import { isVisible, matchElement } from '../../src/device/element-matcher.js';

let n = 0;
const el = (label: string, kind = 'text'): ScreenElement => ({ id: `e${++n}`, label, x: 10 * n, y: 20 * n, kind });

const screen = [
  el('9:41'),
  el('Settings'),
  el('Wi-Fi'),
  el('Café Guest'),
  el('Personal Hotspot'),
  el('', 'icon ~28pt'),
  el('General'),
  el('Privacy & Security'),
];

describe('matchElement', () => {
  it('prefers an exact match', () => {
    expect(matchElement(screen, 'Wi-Fi')).toMatchObject({ element: { label: 'Wi-Fi' }, strategy: 'exact' });
    expect(matchElement(screen, '  General ')).toMatchObject({ element: { label: 'General' }, strategy: 'exact' });
  });

  it('falls back to case-insensitive, then diacritic-insensitive', () => {
    expect(matchElement(screen, 'wi-fi')?.strategy).toBe('case-insensitive');
    expect(matchElement(screen, 'cafe guest')).toMatchObject({ element: { label: 'Café Guest' }, strategy: 'diacritic-insensitive' });
  });

  it('matches substrings (element contains the label)', () => {
    expect(matchElement(screen, 'Hotspot')).toMatchObject({ element: { label: 'Personal Hotspot' }, strategy: 'substring' });
    expect(matchElement(screen, 'privacy')).toMatchObject({ element: { label: 'Privacy & Security' }, strategy: 'substring' });
  });

  it('matches reverse substrings only for long enough element text', () => {
    // "General" (7) is long enough for a 12-character label: max(3, ceil(12 / 2)) = 6.
    expect(matchElement(screen, 'General tab!')).toMatchObject({ element: { label: 'General' }, strategy: 'reverse-substring' });
    // "Wi-Fi" (5) is too short for "Wi-Fi network settings" (needs ≥ 11).
    expect(matchElement(screen, 'Wi-Fi network settings')).toBeNull();
  });

  it('never matches unlabeled icons and returns null for empty labels', () => {
    expect(matchElement(screen, '')).toBeNull();
    expect(matchElement(screen, '   ')).toBeNull();
    expect(matchElement([el('', 'icon ~60pt')], 'x')).toBeNull();
  });

  it('uses reading order within a tier', () => {
    const dupes = [el('Send'), el('send'), el('SEND')];
    expect(matchElement(dupes, 'Send')?.element.id).toBe(dupes[0]!.id);
    expect(matchElement(dupes, 'send')?.element.id).toBe(dupes[1]!.id);
    expect(matchElement(dupes, 'sEnD')).toMatchObject({ element: { id: dupes[0]!.id }, strategy: 'case-insensitive' });
  });

  it('supports exact-only matching for workflows that ask for it', () => {
    expect(matchElement(screen, 'wi-fi', { exactOnly: true })).toBeNull();
    expect(matchElement(screen, 'Wi-Fi', { exactOnly: true })?.strategy).toBe('exact');
  });

  it('matches Arabic labels', () => {
    const ar = [el('الإعدادات'), el('حذف الحساب')];
    expect(matchElement(ar, 'الإعدادات')?.strategy).toBe('exact');
    expect(matchElement(ar, 'حذف')).toMatchObject({ element: { label: 'حذف الحساب' }, strategy: 'substring' });
  });
});

describe('isVisible', () => {
  it('reports visibility with any strategy', () => {
    expect(isVisible(screen, 'settings')).toBe(true);
    expect(isVisible(screen, 'Bluetooth')).toBe(false);
  });
});
