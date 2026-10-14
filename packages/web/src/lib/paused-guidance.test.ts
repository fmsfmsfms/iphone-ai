// iPhone Mirroring only works while the iPhone stays LOCKED: unlocking or
// using the phone pauses or ends the session. Paused guidance must never tell
// the user to unlock it (English or Arabic).

import { describe, expect, it } from 'vitest';

import '../pages/activity/messages';
import '../pages/assistant/messages';
import '../pages/automations/messages';
import '../pages/dashboard/messages';
import '../pages/live/messages';
import '../pages/settings/messages';
import { getCatalog } from './i18n';
import { arMessages, enMessages } from './messages';

const UNLOCK = [/unlock/i, /(?:افتح|فتح)\s+قفل/];

function dashboard(language: 'en' | 'ar'): Record<string, string> {
  return Object.fromEntries(Object.entries(getCatalog(language)).filter(([key]) => key.startsWith('dashboard.')));
}

const CATALOGS: [string, Record<string, string>][] = [
  ['lib/messages.ts (en)', enMessages],
  ['lib/messages.ts (ar)', arMessages],
  ['dashboard/messages.ts (en)', dashboard('en')],
  ['dashboard/messages.ts (ar)', dashboard('ar')],
  // Every page catalog registered above, so no screen can bring the advice back.
  ['all catalogs (en)', getCatalog('en')],
  ['all catalogs (ar)', getCatalog('ar')],
];

const PAUSED_KEYS = ['status.mirroring.pausedHint', 'input.reason.paused', 'viewer.block.paused.body', 'dashboard.onboarding.mirroring.paused'];

describe('paused guidance', () => {
  it.each(CATALOGS)('%s never tells the user to unlock the iPhone', (_name, messages) => {
    const offending = Object.entries(messages).filter(([, text]) => UNLOCK.some((pattern) => pattern.test(text)));
    expect(offending).toEqual([]);
  });

  it('tells the user to keep the iPhone locked and nearby, then Resume', () => {
    for (const key of PAUSED_KEYS) {
      expect(getCatalog('en')[key], key).toMatch(/Lock your iPhone and keep it nearby, then click Resume/);
      expect(getCatalog('ar')[key], key).toMatch(/اقفل iPhone وأبقه قريبًا، ثم انقر على «استئناف»/);
    }
  });
});
