// The post-approval re-check (screenDiff): an approved action is dropped when
// the screen changed while the card was open, but OCR noise must not count.
// Fixtures are describe_screen output recorded on the user's real iPhone
// (iPhone Mirroring window 356×785 pt, status bar at y≈63): in v0.4.0 the
// Jahez task below forced four second approvals on noise alone. The attack
// cases come from the v0.4.1 review (each slipped past a length-only rule) and
// the v0.5.0 verification (each slipped past the first position-aware rule).
// Pure function; no Mirroir, no phone.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SENSITIVE_RULES, type ScreenDescription, type ScreenElement } from '@iphone-ai/shared';

import { screenDiff } from '../../src/ai/agent/toolkit.js';
import { makeGeometry, parseDescribeScreen, screenFingerprint } from '../../src/mcp/parsers.js';

interface Recorded {
  jahez: Record<string, string>;
  statusRows: { task: string; step: number; elements: [label: string, x: number, y: number][] }[];
}
const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/recorded-observations.json', import.meta.url), 'utf8')) as Recorded;

function described(elements: ScreenElement[], heightPt = 785, widthPt = 356): ScreenDescription {
  const geometry = makeGeometry(widthPt, heightPt, widthPt > heightPt ? 'landscape' : 'portrait');
  return {
    capturedAt: Date.now(),
    elements,
    rawText: '',
    imageBase64: null,
    imageMimeType: null,
    geometry,
    fingerprint: screenFingerprint(elements, geometry.heightPt),
  };
}

/** A recorded Jahez observation, parsed as DeviceController.describe parses it. */
const jahez = (step: number) => described(parseDescribeScreen(RECORDED.jahez[String(step)]!).elements);

type E = [label: string, x: number, y: number];
const screen = (elements: E[], heightPt?: number, widthPt?: number) =>
  described(
    elements.map(([label, x, y], i): ScreenElement => ({ id: `e${i + 1}`, label, x, y, kind: 'text' })),
    heightPt,
    widthPt,
  );

/** The status bar as recorded on the device (clock, signal, battery at y≈63). */
const STATUS: E[] = [
  ['3:16 M', 72, 63],
  ['•ll 4G 60', 278, 63],
  ['67', 299, 63],
];
const ORDER: E[] = [...STATUS, ['Your order', 178, 120], ['Big Mac Meal', 120, 300], ['Delivery fee', 120, 340], ['Promo code', 120, 420]];

describe('screenDiff on recorded real-device observations', () => {
  it('passes the four re-checks that OCR noise refused in v0.4.0', () => {
    // #15→#17: clock "3:16 M" → "3:171", Arabic text re-read "jai" → "jaû" at (64, 151).
    expect(screenDiff(jahez(15), jahez(17))).toBeNull();
    // #34→#38: battery "9 ÷ ||" → "29 ÷ ||", clock "3:17 A" → "3:17 1", caret "• cheese" → "• cheese|".
    expect(screenDiff(jahez(34), jahez(38))).toBeNull();
    // #38→#41: the same, back again ("3:17 a").
    expect(screenDiff(jahez(38), jahez(41))).toBeNull();
    // #44→#48: the clock "3:18 \" was not read before (no text at all), then was.
    expect(screenDiff(jahez(44), jahez(48))).toBeNull();
  });

  it('still passes the re-checks that passed', () => {
    expect(screenDiff(jahez(17), jahez(21))).toBeNull();
    expect(screenDiff(jahez(27), jahez(31))).toBeNull();
    expect(screenDiff(jahez(48), jahez(51))).toBeNull();
  });

  it('still refuses the genuine change (#9→#12: the search results loaded after typing)', () => {
    expect(screenDiff(jahez(9), jahez(12))).toMatch(/^new text appeared/);
  });

  it('ignores the status-bar row of every recorded observation, except where content covered it', () => {
    const rows = RECORDED.statusRows;
    const content: E[] = [['Search the menu', 178, 160], ['Big Mac', 120, 300]];
    const refused: string[] = [];
    let pairs = 0;
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i]!.task !== rows[i - 1]!.task) continue;
      pairs += 1;
      const change = screenDiff(screen([...rows[i - 1]!.elements, ...content]), screen([...rows[i]!.elements, ...content]));
      if (change) refused.push(`${rows[i]!.task}#${rows[i]!.step}: ${change}`);
    }
    expect(pairs).toBe(81);
    // Both are real content, not status-bar flicker: a video caption at y=56
    // above the status row, and a screen with no clock visible (no band then).
    expect(refused).toEqual(['T2#2: new text appeared (“• loukalios”)', 'T7#27: new text appeared (“ruff.”)']);
  });
});

describe('screenDiff: OCR noise that does not count', () => {
  it('ignores clock and signal flicker on the status row found by the clock', () => {
    const later: E[] = [['3:17 A', 72, 63], ['•Ill 4G 60', 278, 63], ['67', 299, 63], ...ORDER.slice(3)];
    expect(screenDiff(screen(ORDER), screen(later))).toBeNull();
    // A smaller window: the clock anchors the row wherever it is in the top 12%.
    const small: E[] = [['9:41', 40, 20], ['Settings', 88, 117]];
    expect(screenDiff(screen(small, 400), screen([['9:42 a', 40, 20], ['87%', 330, 21], ['Settings', 88, 117]], 400))).toBeNull();
  });

  it('ignores a caret and a re-read at the same spot (a garbled letter, i/l mixed up, spaces)', () => {
    const field: E[] = [...ORDER, ['• cheese', 66, 104]];
    expect(screenDiff(screen(field), screen([...ORDER, ['• cheese|', 66, 104]]))).toBeNull();
    // OCR reading Arabic in Latin mode garbles a letter; text centres move a little.
    expect(screenDiff(screen([...ORDER, ['jai', 64, 151]]), screen([...ORDER, ['jaû', 64, 151]]))).toBeNull();
    expect(screenDiff(screen([...ORDER, ['НОВА', 308, 550]]), screen([...ORDER, ['HОВА', 309, 550]]))).toBeNull();
    expect(screenDiff(screen([...ORDER, ['Mail', 150, 500]]), screen([...ORDER, ['MaiI', 151, 500]]))).toBeNull();
    expect(screenDiff(screen([...ORDER, ['SAR 49.00', 280, 600]]), screen([...ORDER, ['SAR49.00', 282, 600]]))).toBeNull();
  });

  it('ignores digits-and-symbols fragments and a lone letter in the status area, off the clock row', () => {
    // The top 12% (y < 94 here): battery and signal glyphs read apart, an icon read as a letter.
    expect(screenDiff(screen(ORDER), screen([...ORDER, ['29 ÷ ||', 280, 84]]))).toBeNull();
    expect(screenDiff(screen(ORDER), screen([...ORDER, ['Q', 200, 84]]))).toBeNull();
    // A misread clock with no clock row to anchor it (recorded: "฿112").
    expect(screenDiff(screen(ORDER.slice(3)), screen([['฿112', 64, 62], ...ORDER.slice(3)]))).toBeNull();
  });

  it('ignores a counter or relative time that ticked at the same spot', () => {
    const cases: [string, string][] = [['5m', '6m'], ['2h', '3h'], ['• 9.5K', '• 9.6K'], ['1.2M', '1.3M'], ['45s', '46s']];
    for (const [was, now] of cases) {
      expect(screenDiff(screen([...ORDER, [was, 324, 468]]), screen([...ORDER, [now, 324, 468]])), now).toBeNull();
    }
  });

  it('ignores numbers that tick on their own and items that only moved', () => {
    expect(screenDiff(screen([...ORDER, ['0:35.10', 178, 500]]), screen([...ORDER, ['0:41.72', 178, 500]]))).toBeNull();
    const scrolled = ORDER.map(([l, x, y]): E => (y > 100 ? [l, x, y - 40] : [l, x, y]));
    expect(screenDiff(screen(ORDER), screen(scrolled))).toBeNull();
  });
});

describe('screenDiff: changes that still refuse (v0.4.1 review attack cases)', () => {
  it('a short alert or answer at a spot that was empty ("Pay" / "OK" / "No", Arabic)', () => {
    expect(screenDiff(screen(ORDER), screen([...ORDER, ['Pay', 178, 380], ['OK', 120, 460], ['No', 240, 460]]))).toMatch(/new text appeared/);
    for (const word of ['OK', 'No', 'Yes', 'Get', 'Buy', 'Pay', 'Mom', 'حذف', 'دفع', 'نعم', 'تم', 'لا', 'ok?']) {
      expect(screenDiff(screen(ORDER), screen([...ORDER, [word, 178, 500]])), word).toMatch(/new text appeared/);
    }
  });

  it('a decision word or sensitive keyword even when it replaces similar text at the same spot', () => {
    // One letter apart, so a plain re-read rule would call them noise.
    expect(screenDiff(screen([...ORDER, ['Nes', 150, 700]]), screen([...ORDER, ['Yes', 150, 700]]))).toMatch(/“yes”/);
    expect(screenDiff(screen([...ORDER, ['Bay', 150, 700]]), screen([...ORDER, ['Buy', 150, 700]]))).toMatch(/“buy”/);
    expect(screenDiff(screen([...ORDER, ['Sent', 150, 700]]), screen([...ORDER, ['Send', 150, 700]]))).toMatch(/“send”/);
    expect(screenDiff(screen([...ORDER, ['Send to Mom', 150, 700]]), screen([...ORDER, ['Send to Tom', 150, 700]]))).toMatch(/“send to tom”/);
    expect(screenDiff(screen([...ORDER, ['Walet', 150, 700]]), screen([...ORDER, ['Wallet', 150, 700]]))).toMatch(/“wallet”/);
  });

  it('a keyword of a live sensitive rule the defaults do not have', () => {
    // A garbled re-read, so only the keyword makes it count.
    const before = screen([...ORDER, ['Gift cärd', 150, 700]]);
    const after = screen([...ORDER, ['Gift card', 150, 700]]);
    expect(screenDiff(before, after)).toBeNull();
    const rules = [...DEFAULT_SENSITIVE_RULES, { id: 'gifts', label: 'Gift cards', keywords: ['gift card'], effect: 'require_approval' as const, enabled: true }];
    expect(screenDiff(before, after, { sensitiveRules: rules })).toMatch(/“gift card”/);
  });

  it('a button relabelled at the same spot (Next → Buy, Add → Pay)', () => {
    expect(screenDiff(screen([...ORDER, ['Next', 150, 700]]), screen([...ORDER, ['Buy', 150, 700]]))).toMatch(/“buy”/);
    expect(screenDiff(screen([...ORDER, ['Add', 150, 700]]), screen([...ORDER, ['Pay', 150, 700]]))).toMatch(/“pay”/);
  });

  it('an amount whose digits changed, however the currency is written', () => {
    const cases: [string, string][] = [
      ['SAR 49.00', 'SAR 149.00'],
      ['49 SR', '149 SR'],
      ['49 ر.س', '149 ر.س'],
      ['49 ﷼', '149 ﷼'],
      ['\u20c1 49', '\u20c1 149'],
      ['$4.99', '$14.99'],
      ['€5', '€6'],
      // OCR reads the Saudi riyal sign as "#" (recorded: "# 19.00").
      ['# 19.00', '# 119.00'],
    ];
    for (const [was, now] of cases) {
      expect(screenDiff(screen([...ORDER, [was, 280, 600]]), screen([...ORDER, [now, 280, 600]])), now).toMatch(/new text appeared/);
    }
    // "SAR" read apart from the number on the same line.
    expect(
      screenDiff(screen([...ORDER, ['SAR', 240, 600], ['49.00', 290, 600]]), screen([...ORDER, ['SAR', 240, 600], ['149.00', 292, 600]])),
    ).toMatch(/“149.00”/);
    // The same amount re-read is not a change.
    expect(screenDiff(screen([...ORDER, ['SAR 49.00', 280, 600]]), screen([...ORDER, ['SAR 49.00|', 281, 600]]))).toBeNull();
  });

  it('a notification banner, even one made of short words', () => {
    const page: E[] = [...STATUS, ["x McDonald's", 79, 105], ['Big Mac', 120, 300], ['Cheeseburger', 120, 380]];
    // The banner covers the clock: no clock, no status-bar band.
    expect(screenDiff(screen(page), screen([...STATUS.slice(1), ['Mom', 90, 78], ['OK', 90, 96], ...page.slice(3)]))).toMatch(/“mom”/);
    expect(screenDiff(screen(page), screen([...STATUS.slice(1), ['Al Rajhi Bank', 120, 70], ['OK', 120, 92], ...page.slice(3)]))).toMatch(
      /new text appeared/,
    );
  });

  it('text just outside the status row, and status-row text when no clock anchors it', () => {
    // 9 pt below the clock is not the status row.
    expect(screenDiff(screen(ORDER), screen([...ORDER, ['Al Rajhi', 150, 72]]))).toMatch(/“al rajhi”/);
    // A clock-like text outside the top 12% does not anchor a band.
    const noClock: E[] = [['Alarm', 60, 300], ['Big Mac', 120, 400]];
    expect(screenDiff(screen(noClock), screen([...noClock, ['7:30', 60, 330], ['Snooze', 120, 330]]))).toMatch(/“snooze”/);
  });

  it('most of the screen gone', () => {
    expect(screenDiff(screen(ORDER), screen([...STATUS, ['Messages', 178, 120]]))).not.toBeNull();
  });
});

describe('screenDiff: changes that still refuse (v0.5.0 verification attack cases)', () => {
  it('digits and symbols below the status area: a masked card number, a quantity, an unlisted currency', () => {
    const pay: E[] = [...ORDER, ['Pay with', 100, 500], ['Mada', 100, 540]];
    expect(screenDiff(screen([...pay, ['•••• 4321', 250, 540]]), screen([...pay, ['•••• 9876', 250, 540]]))).toMatch(/“•••• 9876”/);
    expect(screenDiff(screen([...ORDER, ['×2', 300, 300]]), screen([...ORDER, ['×3', 300, 300]]))).toMatch(/“×3”/);
    for (const sign of ['฿', '₩', '₹', '₺', '₽', '₪']) {
      const before = screen([...ORDER, ['Total', 60, 600], [`${sign} 49.00`, 280, 600]]);
      expect(screenDiff(before, screen([...ORDER, ['Total', 60, 600], [`${sign} 149.00`, 280, 600]])), sign).toMatch(/new text appeared/);
      // Read apart from its number on the same line.
      const apart = screen([...ORDER, [sign, 250, 600], ['49.00', 290, 600]]);
      expect(screenDiff(apart, screen([...ORDER, [sign, 250, 600], ['149.00', 292, 600]])), sign).toMatch(/“149.00”/);
    }
    // A symbol that appeared below the status area counts (a check mark, a fragment).
    expect(screenDiff(screen(ORDER), screen([...ORDER, ['29 ÷ ||', 200, 520]]))).toMatch(/“29 ÷”/);
  });

  it('a one-character change that is not OCR garble', () => {
    const pairs: [string, string][] = [
      ['To: Ahmed', 'To: Ahmad'],
      ['Mom', 'Tom'],
      ['سعد', 'سعيد'],
      ["McDonald's", "x McDonald's"],
      ['Visa 9876', '✓ Visa 9876'],
      ['-SAR 49.00', 'SAR 49.00'],
      ['SAR 49.00', 'SAR 4,900'],
      ['SAR 49.00', 'SAR 4.900'],
    ];
    for (const [was, now] of pairs) {
      expect(screenDiff(screen([...ORDER, [was, 150, 600]]), screen([...ORDER, [now, 152, 600]])), now).toMatch(/new text appeared/);
    }
    // A selection mark read as "v" moving to the other card.
    const before = screen([...ORDER, ['v Mada 4321', 150, 520], ['Visa 9876', 150, 570]]);
    expect(screenDiff(before, screen([...ORDER, ['Mada 4321', 150, 520], ['v Visa 9876', 150, 570]]))).toMatch(/new text appeared/);
  });

  it('a lone glyph or an OCR "0K" / "N0" at an empty spot below the status area', () => {
    for (const word of ['是', '否', '好', '0K', 'N0', 'Q']) {
      expect(screenDiff(screen(ORDER), screen([...ORDER, [word, 178, 500]])), word).toMatch(/new text appeared/);
    }
  });

  it('a counter only ticks with the same unit at the same spot, and never as an amount', () => {
    expect(screenDiff(screen(ORDER), screen([...ORDER, ['6m', 324, 468]]))).toMatch(/“6m”/);
    expect(screenDiff(screen([...ORDER, ['5m', 324, 468]]), screen([...ORDER, ['6h', 324, 468]]))).toMatch(/“6h”/);
    expect(screenDiff(screen([...ORDER, ['$5k', 324, 468]]), screen([...ORDER, ['$6k', 324, 468]]))).toMatch(/“\$6k”/);
    expect(screenDiff(screen([...ORDER, ['2 items', 324, 468]]), screen([...ORDER, ['3 items', 324, 468]]))).toMatch(/“3 items”/);
  });

  it('an amount, decision word, keyword or blocked app on the status row', () => {
    for (const word of ['Pay', 'Allow', 'OK', 'Delete', 'Wallet', 'SAR 49']) {
      expect(screenDiff(screen(ORDER), screen([...ORDER, [word, 178, 66]])), word).toMatch(/new text appeared/);
    }
  });

  it('content that starts like a time never anchors the status row', () => {
    // The clock misread ("฿112"): a total in the top band does not become the anchor.
    const before = screen([...STATUS, ['49.00 SAR', 300, 88], ...ORDER.slice(3)]);
    const after = screen([['฿112', 64, 62], ['•ll 4G 60', 278, 63], ['99.00 SAR', 300, 88], ...ORDER.slice(3)]);
    expect(screenDiff(before, after)).toMatch(/“99.00 sar”/);
    // No clock: a banner line starting with a time, centred, next to "Pay".
    expect(screenDiff(screen(ORDER), screen([['12:30 Confirm payment', 178, 80], ['Pay', 300, 84], ...ORDER.slice(3)]))).toMatch(
      /new text appeared/,
    );
    // Landscape (no status bar): a top line starting with a time, with a purchase beside it.
    const wide = (elements: E[]) => screen(elements, 356, 785);
    const top: E[] = [['12:30 Flight to Jeddah', 200, 30], ['Big Mac', 120, 100], ['Add', 600, 100]];
    expect(screenDiff(wide(top), wide([...top, ['Buy ticket SAR 1,249', 600, 33]]))).toMatch(/“buy ticket sar 1,249”/);
  });
});
