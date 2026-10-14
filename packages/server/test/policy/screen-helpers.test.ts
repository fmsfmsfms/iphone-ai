// Pure helpers behind the coordinate-tap, blocked-foreground and
// uncommitted-typing safety checks.

import { describe, expect, it } from 'vitest';

import { createDefaultSettings, type PolicyDecision, type ScreenElement } from '@iphone-ai/shared';

import { detectBlockedForeground } from '../../src/policy/foreground.js';
import { labelsAtPoint } from '../../src/policy/target.js';
import { nextUncommittedTyping } from '../../src/policy/typing.js';

const BLOCKED = createDefaultSettings().permissions.blockedApps;
let n = 0;
const el = (label: string, x: number, y: number): ScreenElement => ({ id: `e${++n}`, label, x, y, kind: label ? 'text' : 'icon' });

describe('labelsAtPoint', () => {
  // Settings, scrolled: row labels are left-aligned text centres; rows span the full width.
  const settings = [el('General', 112, 220), el('Wallet & Apple Pay', 157, 818), el('Privacy & Security', 157, 644), el('Apps', 98, 860)];

  it('returns the nearest label within the radius as the primary target', () => {
    expect(labelsAtPoint(settings, 150, 820)).toEqual({ primary: 'Wallet & Apple Pay', candidates: ['Wallet & Apple Pay'], nearby: [] });
  });

  it('falls back to the row band for a tap on the right side of a full-width row', () => {
    expect(labelsAtPoint(settings, 380, 818)).toEqual({ primary: null, candidates: ['Wallet & Apple Pay'], nearby: [] });
    expect(labelsAtPoint(settings, 220, 644).candidates).toEqual(['Privacy & Security']);
  });

  it('reports nearby labels for a point that hits nothing', () => {
    expect(labelsAtPoint([el('Delete', 300, 100)], 300, 160)).toEqual({ primary: null, candidates: [], nearby: ['Delete'] });
    expect(labelsAtPoint([el('Delete', 300, 100)], 30, 870)).toEqual({ primary: null, candidates: [], nearby: [] });
  });

  it('ignores unlabeled icons', () => {
    expect(labelsAtPoint([el('', 378, 800)], 378, 800)).toEqual({ primary: null, candidates: [], nearby: [] });
  });
});

describe('detectBlockedForeground', () => {
  it('flags a blocked app named in the title area', () => {
    expect(detectBlockedForeground([el('9:41', 64, 27), el('Wallet', 90, 117), el('Apple Cash', 205, 430)], 898, BLOCKED)).toEqual({
      app: 'Wallet',
      label: 'Wallet',
      where: 'header',
    });
  });

  it("flags Spotlight's top hit", () => {
    const spotlight = [el('Top Hit', 70, 120), el('Wallet', 143, 190), el('Search Web', 100, 520), el('Q Walle', 205, 780)];
    expect(detectBlockedForeground(spotlight, 898, BLOCKED)).toMatchObject({ app: 'Wallet', where: 'top_hit' });
  });

  it('ignores icon grids, rows lower on the screen and harmless titles', () => {
    const home = [el('Health', 63, 112), el('Wallet', 158, 112), el('Settings', 252, 112), el('Weather', 347, 112)];
    expect(detectBlockedForeground(home, 898, BLOCKED)).toBeNull();
    expect(detectBlockedForeground([el('Notifications', 205, 70), el('Wallet', 61, 779)], 898, BLOCKED)).toBeNull();
    expect(detectBlockedForeground([el('Settings', 88, 117), el('Q Search', 204, 172)], 898, BLOCKED)).toBeNull();
    expect(detectBlockedForeground([el('Wallet', 90, 117)], 898, [])).toBeNull();
  });
});

describe('nextUncommittedTyping', () => {
  const allow: PolicyDecision = { verdict: 'allow', risk: 'low', reasons: [], rules: [] };
  const approvedCommit: PolicyDecision = { verdict: 'require_approval', risk: 'high', reasons: [], rules: ['commit.after_typing'] };
  const ev = (action: Parameters<typeof nextUncommittedTyping>[1]['action'], actor: 'ai' | 'workflow' | 'user' = 'ai', extra: { approvalId?: string; decision?: PolicyDecision; ok?: boolean } = {}) => ({
    action,
    ctx: { actor, approvalId: extra.approvalId ?? null, decision: extra.decision ?? allow },
    ok: extra.ok ?? true,
  });

  it('is set by typing from any actor and survives unapproved taps', () => {
    let state = nextUncommittedTyping(false, ev({ kind: 'type_text', text: 'I quit' }, 'workflow'));
    expect(state).toBe(true);
    state = nextUncommittedTyping(state, ev({ kind: 'tap', x: 180, y: 800 }, 'ai'));
    expect(state).toBe(true);
    state = nextUncommittedTyping(state, ev({ kind: 'press_key', key: 'return' }, 'workflow'));
    expect(state).toBe(true);
    expect(nextUncommittedTyping(false, ev({ kind: 'type_text', text: 'hi' }, 'user'))).toBe(true);
  });

  it('is cleared by an approved commit, by the user committing, or by leaving the app', () => {
    expect(nextUncommittedTyping(true, ev({ kind: 'tap', x: 378, y: 800 }, 'ai', { approvalId: 'apr_1', decision: approvedCommit }))).toBe(false);
    expect(nextUncommittedTyping(true, ev({ kind: 'press_key', key: 'return' }, 'user'))).toBe(false);
    expect(nextUncommittedTyping(true, ev({ kind: 'press_home' }))).toBe(false);
    expect(nextUncommittedTyping(true, ev({ kind: 'launch_app', name: 'Notes' }))).toBe(false);
    // Text ending in a line break was committed by that Return.
    expect(nextUncommittedTyping(false, ev({ kind: 'type_text', text: 'hi\n' }))).toBe(false);
    // A failed commit leaves the draft in place.
    expect(nextUncommittedTyping(true, ev({ kind: 'press_home' }, 'ai', { ok: false }))).toBe(true);
  });
});
