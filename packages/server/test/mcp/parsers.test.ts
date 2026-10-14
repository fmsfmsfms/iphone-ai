// Parsers for Mirroir 0.40.1 text outputs, fed with real strings (formats
// from Mirroir's Swift source and the live binary; dashes are U+2014).

import { describe, expect, it } from 'vitest';

import {
  classifyInputError,
  geometryId,
  isPermissionDenial,
  makeGeometry,
  parseDescribeScreen,
  parseDoctorJson,
  parseHealth,
  parseOrientation,
  parseStatus,
  parseTargets,
  screenFingerprint,
} from '../../src/mcp/parsers.js';
import type { ScreenElement } from '@iphone-ai/shared';

describe('parseStatus', () => {
  it('parses a connected session with geometry', () => {
    const parsed = parseStatus('Connected — mirroring active (window: 410x898, pos=(1200,80), portrait)');
    expect(parsed.state).toBe('connected');
    expect(parsed.geometry).toEqual({ widthPt: 410, heightPt: 898, x: 1200, y: 80, orientation: 'portrait' });
  });

  it('parses negative window positions and landscape', () => {
    const parsed = parseStatus('Connected — mirroring active (window: 868x440, pos=(-1500,-20), landscape)');
    expect(parsed.geometry).toEqual({ widthPt: 868, heightPt: 440, x: -1500, y: -20, orientation: 'landscape' });
  });

  it('keeps connected without geometry when the window info is unknown', () => {
    const parsed = parseStatus('Connected — mirroring active (window: unknown, pos=unknown, unknown)');
    expect(parsed.state).toBe('connected');
    expect(parsed.geometry).toBeNull();
  });

  it('parses paused, not running and no window', () => {
    expect(parseStatus('Paused — connection paused, can resume')).toMatchObject({ state: 'paused', geometry: null });
    expect(parseStatus("Not running — 'iphone' is not open")).toMatchObject({ state: 'not_running', geometry: null });
    expect(parseStatus('No window — app is running but no mirroring window found')).toMatchObject({
      state: 'no_window',
      geometry: null,
    });
  });

  it('maps anything else to error and keeps the raw text', () => {
    const parsed = parseStatus("  Unknown target 'nope'\n");
    expect(parsed.state).toBe('error');
    expect(parsed.raw).toBe("Unknown target 'nope'");
    expect(parseStatus('').state).toBe('error');
  });
});

describe('parseOrientation', () => {
  it('parses portrait and landscape', () => {
    expect(parseOrientation('Orientation: portrait (window: 355x782)')).toEqual({
      orientation: 'portrait',
      widthPt: 355,
      heightPt: 782,
    });
    expect(parseOrientation('Orientation: landscape (window: 898x410)')).toEqual({
      orientation: 'landscape',
      widthPt: 898,
      heightPt: 410,
    });
  });

  it('returns null for the error text', () => {
    expect(parseOrientation("Cannot determine orientation. Is target 'iphone' running?")).toBeNull();
  });
});

describe('parseTargets', () => {
  it('parses the live list_targets line', () => {
    expect(parseTargets('- iphone (active): paused (355x782) [appSwitcher, home, menuActions, spotlight]')).toEqual([
      {
        name: 'iphone',
        active: true,
        state: 'paused',
        widthPt: 355,
        heightPt: 782,
        capabilities: ['appSwitcher', 'home', 'menuActions', 'spotlight'],
      },
    ]);
  });

  it("parses 'no window' sizes, generic targets and several lines", () => {
    const text = [
      '- android: noWindow (no window) [generic]',
      '- claude: notRunning (no window) [generic]',
      '- iphone (active): connected (410x898) [appSwitcher, home, menuActions, spotlight]',
    ].join('\n');
    const targets = parseTargets(text);
    expect(targets).toHaveLength(3);
    expect(targets[0]).toEqual({
      name: 'android',
      active: false,
      state: 'noWindow',
      widthPt: null,
      heightPt: null,
      capabilities: ['generic'],
    });
    expect(targets[1]).toMatchObject({ name: 'claude', state: 'notRunning', widthPt: null });
    expect(targets[2]).toMatchObject({ name: 'iphone', active: true, state: 'connected', widthPt: 410, heightPt: 898 });
  });

  it('ignores unrelated lines', () => {
    expect(parseTargets("Unknown target 'x'\n\n")).toEqual([]);
  });
});

describe('geometry helpers', () => {
  it('builds geometry ids and infers orientation', () => {
    expect(geometryId(410, 898)).toBe('410x898');
    expect(makeGeometry(410, 898)).toMatchObject({ geometryId: '410x898', orientation: 'portrait', widthPt: 410, heightPt: 898 });
    expect(makeGeometry(898, 410).orientation).toBe('landscape');
    expect(makeGeometry(410, 898, 'landscape').orientation).toBe('landscape');
  });
});

describe('parseDescribeScreen', () => {
  const settingsScreen = [
    'Screen elements (tap coordinates in points):',
    '- "9:41" at (64, 27)',
    '- "< Settings" at (60, 70)',
    '- "Enter Password" at (205, 70)',
    '- "Enter the password for "Cafe Guest"" at (205, 130)',
    '- "Say "hi" to "Mom"" at (150, 160)',
    '- "Wi-Fi" at (104, 392)',
    '',
    'Unlabeled icons (estimated positions):',
    '- Icon at (41, 850), ~24x24pt',
    '- Icon at (372, 84), ~28x28pt',
    '',
    'Hints:',
    '- Back navigation: "<" detected — tap it to go back.',
    '- Tab bar: 5 items detected in the bottom band — tap one to switch sections.',
    '',
    '_meta: ocr_time_ms=142 recognition_level=accurate element_count=6',
  ].join('\n');

  it('parses elements in reading order with ids, keeping quotes inside labels', () => {
    const parsed = parseDescribeScreen(settingsScreen);
    const texts = parsed.elements.filter((e) => e.kind === 'text');
    expect(texts.map((e) => e.label)).toEqual([
      '9:41',
      '< Settings',
      'Enter Password',
      'Enter the password for "Cafe Guest"',
      'Say "hi" to "Mom"',
      'Wi-Fi',
    ]);
    expect(texts[3]).toEqual({ id: 'e4', label: 'Enter the password for "Cafe Guest"', x: 205, y: 130, kind: 'text' });
    expect(parsed.ocrFailed).toBe(false);
    expect(parsed.noText).toBe(false);
    expect(parsed.scrolled).toBe(false);
  });

  it('turns unlabeled icons into addressable elements after the text elements', () => {
    const parsed = parseDescribeScreen(settingsScreen);
    expect(parsed.icons).toEqual([
      { x: 41, y: 850, sizePt: 24 },
      { x: 372, y: 84, sizePt: 28 },
    ]);
    expect(parsed.elements.slice(-2)).toEqual([
      { id: 'e7', label: '', x: 41, y: 850, kind: 'icon ~24pt' },
      { id: 'e8', label: '', x: 372, y: 84, kind: 'icon ~28pt' },
    ]);
  });

  it('parses hints and _meta', () => {
    const parsed = parseDescribeScreen(settingsScreen);
    expect(parsed.hints).toEqual([
      'Back navigation: "<" detected — tap it to go back.',
      'Tab bar: 5 items detected in the bottom band — tap one to switch sections.',
    ]);
    expect(parsed.meta).toEqual({ ocr_time_ms: '142', recognition_level: 'accurate', element_count: '6' });
  });

  it('flags an OCR failure (both the message line and ocr_status=failed)', () => {
    const text = [
      'Screen elements (tap coordinates in points):',
      '(OCR FAILED — text recognition did not run: Vision text recognition failed: busy)',
      'Any icons and hints below come from the non-OCR path; the text layer is missing, not empty.',
      '',
      'Unlabeled icons (estimated positions):',
      '- Icon at (63, 838), ~60x60pt',
      '',
      '_meta: ocr_time_ms=12 recognition_level=accurate element_count=0 ocr_status=failed',
    ].join('\n');
    const parsed = parseDescribeScreen(text);
    expect(parsed.ocrFailed).toBe(true);
    expect(parsed.meta.ocr_status).toBe('failed');
    expect(parsed.elements).toEqual([{ id: 'e1', label: '', x: 63, y: 838, kind: 'icon ~60pt' }]);

    const metaOnly = parseDescribeScreen('Screen elements (tap coordinates in points):\n\n_meta: ocr_status=failed');
    expect(metaOnly.ocrFailed).toBe(true);
  });

  it('distinguishes "no text detected" from a failure', () => {
    const parsed = parseDescribeScreen(
      'Screen elements (tap coordinates in points):\n(no text detected)\n\n_meta: ocr_time_ms=40 recognition_level=accurate element_count=0',
    );
    expect(parsed.noText).toBe(true);
    expect(parsed.ocrFailed).toBe(false);
    expect(parsed.elements).toEqual([]);
  });

  it('recognises the scroll:true (page-absolute) variant', () => {
    const parsed = parseDescribeScreen(
      [
        'Screen elements (page-absolute tap coordinates in points):',
        '- "Settings" at (88, 117)',
        '- "Privacy & Security" at (150, 702)',
        '',
        '_meta: scroll_count=3 total_offset=1011 element_count=42',
      ].join('\n'),
    );
    expect(parsed.scrolled).toBe(true);
    expect(parsed.elements.map((e) => e.label)).toEqual(['Settings', 'Privacy & Security']);
    expect(parsed.meta).toEqual({ scroll_count: '3', total_offset: '1011', element_count: '42' });
  });

  it('accepts CRLF line endings and negative coordinates, and skips malformed lines', () => {
    const parsed = parseDescribeScreen(
      'Screen elements (tap coordinates in points):\r\n- "Edge" at (-3, 12)\r\n- "broken at (1, 2)\r\n- "Fine" at (10, 20)\r\n',
    );
    expect(parsed.elements.map((e) => [e.label, e.x, e.y])).toEqual([
      ['Edge', -3, 12],
      ['Fine', 10, 20],
    ]);
  });
});

describe('parseHealth', () => {
  it('parses an unhealthy report', () => {
    const report = parseHealth(
      [
        'Issues detected',
        '',
        "[ok] 'iphone' process is running",
        "[WARN] 'iphone' is paused — click the window to resume",
        '[FAIL] Screen capture failed — grant Screen Recording permission in System Settings',
        '[ok] Text recognition working (85 ms)',
      ].join('\n'),
    );
    expect(report.ok).toBe(false);
    expect(report.items).toEqual([
      { name: 'iPhone Mirroring process', status: 'ok', detail: "'iphone' process is running" },
      { name: 'Mirroring session', status: 'warn', detail: "'iphone' is paused — click the window to resume" },
      {
        name: 'Screen capture',
        status: 'fail',
        detail: 'Screen capture failed — grant Screen Recording permission in System Settings',
      },
      { name: 'Text recognition (OCR)', status: 'ok', detail: 'Text recognition working (85 ms)' },
    ]);
  });

  it('parses a healthy report', () => {
    const report = parseHealth(
      [
        'All checks passed',
        '',
        "[ok] 'iphone' process is running",
        "[ok] 'iphone' connected (window: 410x898)",
        '[ok] Screen capture working (42 ms)',
        '[ok] Text recognition working (85 ms)',
      ].join('\n'),
    );
    expect(report.ok).toBe(true);
    expect(report.items.map((i) => [i.name, i.status])).toEqual([
      ['iPhone Mirroring process', 'ok'],
      ['Mirroring session', 'ok'],
      ['Screen capture', 'ok'],
      ['Text recognition (OCR)', 'ok'],
    ]);
  });

  it('names failing process and session lines', () => {
    const report = parseHealth(
      "Issues detected\n\n[FAIL] 'iphone' process is not running\n[FAIL] 'iphone' running but no window found",
    );
    expect(report.items.map((i) => i.name)).toEqual(['iPhone Mirroring process', 'Mirroring session']);
  });
});

describe('parseDoctorJson', () => {
  const doctorJson = [
    '{',
    '  "checks" : [',
    '    {',
    '      "detail" : "macOS 27.0.1 (macOS 27)",',
    '      "name" : "macOS version",',
    '      "status" : "passed"',
    '    },',
    '    {',
    '      "detail" : "paused",',
    '      "fix_hint" : "iPhone Mirroring is paused. Unlock your iPhone and click Resume in the mirroring window.",',
    '      "name" : "Mirroring connected",',
    '      "status" : "failed"',
    '    },',
    '    {',
    '      "detail" : "not permitted",',
    '      "name" : "Screen capture",',
    '      "status" : "failed"',
    '    },',
    '    {',
    '      "detail" : "permitted",',
    '      "name" : "Accessibility",',
    '      "status" : "passed"',
    '    }',
    '  ],',
    '  "summary" : {',
    '    "failed" : 2,',
    '    "passed" : 2,',
    '    "total" : 4,',
    '    "warned" : 0',
    '  }',
    '}',
  ].join('\n');

  it('parses the pretty-printed JSON Mirroir writes to stderr', () => {
    const parsed = parseDoctorJson(doctorJson);
    expect(parsed?.checks).toHaveLength(4);
    expect(parsed?.checks[1]).toEqual({
      name: 'Mirroring connected',
      status: 'failed',
      detail: 'paused',
      fix_hint: 'iPhone Mirroring is paused. Unlock your iPhone and click Resume in the mirroring window.',
    });
  });

  it('skips log noise (including braces) printed before the JSON', () => {
    const noisy = `[startup 19:10:14.123] version: 845a981 (2026-10-13 10:22)\n[config 19:10:14.130] {weird: line}\nWarning: something\n${doctorJson}\n`;
    const parsed = parseDoctorJson(noisy);
    expect(parsed?.checks.map((c) => c.name)).toEqual(['macOS version', 'Mirroring connected', 'Screen capture', 'Accessibility']);
  });

  it('returns null for missing or broken JSON', () => {
    expect(parseDoctorJson('')).toBeNull();
    expect(parseDoctorJson('no json here')).toBeNull();
    expect(parseDoctorJson('{"summary": {}}')).toBeNull();
    expect(parseDoctorJson('{\n  "checks" : [ {')).toBeNull();
  });
});

describe('isPermissionDenial', () => {
  it('recognises every Mirroir denial text', () => {
    expect(
      isPermissionDenial(
        "Tool 'tap' requires explicit permission. Use --dangerously-skip-permissions or configure ~/.mirroir-mcp/permissions.json.",
      ),
    ).toBe(true);
    expect(
      isPermissionDenial(
        "Tool 'open_url' is blocked by deny list in permissions config. Remove it from the deny list in ~/.mirroir-mcp/permissions.json to allow it.",
      ),
    ).toBe(true);
    expect(
      isPermissionDenial(
        "Tool 'swipe' is not in the allow list. Add it to the allow list in ~/.mirroir-mcp/permissions.json or use --dangerously-skip-permissions.",
      ),
    ).toBe(true);
    expect(
      isPermissionDenial(
        "App 'Wallet' is blocked by permissions config. Remove it from blockedApps in ~/.mirroir-mcp/permissions.json to allow launching it.",
      ),
    ).toBe(true);
  });

  it('does not flag normal results', () => {
    expect(isPermissionDenial('Tapped at (205, 440)')).toBe(false);
    expect(isPermissionDenial("Launched 'Settings' via Spotlight")).toBe(false);
    expect(isPermissionDenial("Target 'iphone' is paused. Unlock iPhone or click Resume in the mirroring window.")).toBe(false);
  });
});

describe('classifyInputError', () => {
  it('classifies the state, bounds and held-touch errors', () => {
    expect(classifyInputError("Target 'iphone' is paused. Unlock iPhone or click Resume in the mirroring window.")).toBe('paused');
    expect(classifyInputError("Target 'iphone' is not running. Launch iPhone Mirroring first.")).toBe('not_running');
    expect(classifyInputError("Target 'iphone' is not running")).toBe('not_running');
    expect(classifyInputError("Target 'iphone' window not found. Is the app running?")).toBe('no_window');
    expect(
      classifyInputError("Coordinates (500, 20) are outside the 'iphone' window (410x890). x must be 0-410, y must be 0-890."),
    ).toBe('bounds');
    expect(
      classifyInputError(
        'A touch is held at (100, 100), so tap is refused: a click would lift it. Finish it with touch(action:"end") or release it with touch(action:"cancel") first.',
      ),
    ).toBe('held_touch');
  });

  it('returns null for other texts', () => {
    expect(classifyInputError('CGEvent click failed')).toBeNull();
    expect(classifyInputError('Tapped at (1, 2)')).toBeNull();
  });
});

describe('screenFingerprint', () => {
  const el = (label: string, x: number, y: number): ScreenElement => ({ id: 'e', label, x, y, kind: 'text' });
  const base = [el('9:41', 64, 27), el('Settings', 88, 117), el('Wi-Fi', 104, 392), el('Bluetooth', 118, 441)];

  it('ignores the status-bar clock and battery', () => {
    const later = [el('10:02', 64, 27), el('87%', 372, 27), el('Settings', 88, 117), el('Wi-Fi', 104, 392), el('Bluetooth', 118, 441)];
    expect(screenFingerprint(later)).toBe(screenFingerprint(base));
  });

  it('is order independent and tolerant to small OCR jitter', () => {
    const shuffled = [base[2]!, base[0]!, base[3]!, base[1]!];
    expect(screenFingerprint(shuffled)).toBe(screenFingerprint(base));
    const jitter = [el('9:41', 64, 27), el('Settings', 89, 118), el('Wi-Fi', 103, 391), el('Bluetooth', 118, 441)];
    expect(screenFingerprint(jitter)).toBe(screenFingerprint(base));
  });

  it('changes when labels or positions change', () => {
    expect(screenFingerprint([...base, el('Cellular', 112, 490)])).not.toBe(screenFingerprint(base));
    expect(screenFingerprint([el('9:41', 64, 27), el('Settings', 88, 117), el('Wi-Fi', 104, 600), el('Bluetooth', 118, 441)])).not.toBe(
      screenFingerprint(base),
    );
  });

  it('does not ignore clock-like text outside the status bar', () => {
    expect(screenFingerprint([...base, el('87%', 345, 300)])).not.toBe(screenFingerprint(base));
  });

  it('ignores unlabeled icons and returns a 16-hex digest', () => {
    const withIcon = [...base, { id: 'e9', label: '', x: 372, y: 84, kind: 'icon ~28pt' }];
    expect(screenFingerprint(withIcon)).toBe(screenFingerprint(base));
    expect(screenFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});
