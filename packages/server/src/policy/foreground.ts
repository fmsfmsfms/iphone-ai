// Best-effort detection of a blocked app that is already in front.
//
// Launch checks are lexical: an alias ("Apple Pay" opens Wallet), a
// notification, the app switcher or a task that starts inside a blocked app
// all bypass them. After every observation the AI toolkit therefore looks at
// the two places that name the foreground app:
//  • the title area (top ~20% of the screen: navigation/large titles), and
//  • Spotlight's "Top Hit" (what Return would open).
// Icon grids (3+ labels on one line, e.g. the Home Screen's top row) are
// ignored so a blocked app's icon label is not mistaken for a title.
// False positives (e.g. the Settings page "Wallet & Apple Pay") are accepted:
// they only add approvals. Apps whose title is a logo are not detected.

import type { ScreenElement } from '@iphone-ai/shared';

import { matchesBlockedApp, type BlockedForeground } from './engine.js';

const HEADER_FRACTION = 0.2;
/** Status-bar text (clock, battery) sits above this line. */
const STATUS_BAR_BOTTOM = 45;
const SAME_LINE = 12;
const TOP_HIT_REACH = 120;

export function detectBlockedForeground(
  elements: readonly ScreenElement[],
  screenHeightPt: number | null,
  blockedApps: readonly string[],
): BlockedForeground | null {
  if (blockedApps.length === 0) return null;
  const labelled = elements.filter((e) => e.label.trim());

  // Spotlight: the result right below "Top Hit" is what Return opens.
  const topHit = labelled.find((e) => /^top hit$/i.test(e.label.trim()));
  if (topHit) {
    const hit = labelled
      .filter((e) => e !== topHit && e.y > topHit.y && e.y - topHit.y <= TOP_HIT_REACH)
      .sort((a, b) => a.y - b.y)[0];
    const app = hit ? matchesBlockedApp(hit.label, blockedApps) : null;
    if (hit && app) return { app, label: hit.label, where: 'top_hit' };
  }

  const height = screenHeightPt && screenHeightPt > 0 ? screenHeightPt : 898;
  const headerBottom = height * HEADER_FRACTION;
  for (const e of labelled) {
    if (e.y < STATUS_BAR_BOTTOM || e.y > headerBottom) continue;
    const sameLine = labelled.filter((o) => Math.abs(o.y - e.y) <= SAME_LINE).length;
    if (sameLine >= 3) continue;
    const app = matchesBlockedApp(e.label, blockedApps);
    if (app) return { app, label: e.label, where: 'header' };
  }
  return null;
}
