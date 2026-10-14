// Exhaustive behaviour of the pure policy engine.

import { describe, expect, it } from 'vitest';

import {
  createDefaultSettings,
  type Actor,
  type ControlMode,
  type DeviceAction,
  type PermissionSettings,
} from '@iphone-ai/shared';

import {
  checkLaunchName,
  containsKeyword,
  evaluatePolicy,
  matchesBlockedApp,
  matchSensitiveRules,
  normalizeText,
  screenHasAuthPrompt,
  screenHasPaymentSheet,
  type PolicyInput,
} from '../../src/policy/engine.js';

const TAP: DeviceAction = { kind: 'tap', x: 100, y: 200 };

function permissions(patch: Partial<PermissionSettings> = {}): PermissionSettings {
  return { ...createDefaultSettings().permissions, ...patch };
}

function evaluate(overrides: Partial<PolicyInput> & { action?: DeviceAction; label?: string | null } = {}) {
  const { label, ...rest } = overrides;
  return evaluatePolicy({
    actor: 'ai',
    action: TAP,
    mode: 'supervised',
    permissions: permissions(),
    stopLatched: false,
    target: label === undefined ? { label: 'General' } : { label },
    ...rest,
  });
}

describe('emergency stop', () => {
  it('denies every actor while latched', () => {
    for (const actor of ['user', 'remote-user', 'ai', 'workflow', 'system'] as Actor[]) {
      const d = evaluate({ actor, stopLatched: true, permissions: permissions({ manualControlEnabled: true }), remoteControlAllowed: true });
      expect(d).toMatchObject({ verdict: 'deny', risk: 'high', rules: ['stop.latched'] });
    }
  });
});

describe('manual control', () => {
  it('denies the user when manual control is off', () => {
    const d = evaluate({ actor: 'user' });
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(['manual.disabled']);
    expect(d.reasons[0]).toMatch(/Manual control is turned off/);
  });

  it('allows the user when manual control is on, regardless of mode, labels or screen', () => {
    for (const mode of ['observe', 'assisted', 'supervised'] as ControlMode[]) {
      const d = evaluate({
        actor: 'user',
        mode,
        permissions: permissions({ manualControlEnabled: true }),
        label: 'Delete Account',
        context: { screenTexts: ['Enter Passcode'], pendingTypedText: true },
      });
      expect(d).toEqual({ verdict: 'allow', risk: 'low', reasons: [], rules: [] });
    }
  });

  it('keeps remote sessions view-only unless remote control is allowed', () => {
    const on = permissions({ manualControlEnabled: true });
    expect(evaluate({ actor: 'remote-user', permissions: on }).rules).toEqual(['remote.view_only']);
    expect(evaluate({ actor: 'remote-user', permissions: on, remoteControlAllowed: false }).verdict).toBe('deny');
    expect(evaluate({ actor: 'remote-user', permissions: on, remoteControlAllowed: true }).verdict).toBe('allow');
    expect(evaluate({ actor: 'remote-user', remoteControlAllowed: true }).rules).toEqual(['manual.disabled']);
    expect(evaluate({ actor: 'remote-user' }).rules).toEqual(['manual.disabled', 'remote.view_only']);
  });

  it('never lets the system actor send input', () => {
    expect(evaluate({ actor: 'system' }).rules).toEqual(['actor.system']);
  });
});

describe('AI and workflow actors', () => {
  it('denies everything in Observe Only mode', () => {
    for (const actor of ['ai', 'workflow'] as Actor[]) {
      for (const action of [TAP, { kind: 'press_home' } as DeviceAction, { kind: 'type_text', text: 'hello' } as DeviceAction]) {
        const d = evaluate({ actor, mode: 'observe', action });
        expect(d.verdict).toBe('deny');
        expect(d.rules).toEqual(['mode.observe']);
      }
    }
  });

  it('denies tools that are not in the allowed AI list', () => {
    const d = evaluate({ permissions: permissions({ aiAllowedTools: ['tap'] }), action: { kind: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4 } });
    expect(d.rules).toEqual(['tool.not_allowed']);
    expect(d.reasons[0]).toContain('"swipe"');
    // open_url is not an AI tool by default.
    expect(evaluate({ action: { kind: 'open_url', url: 'https://example.com' } }).rules).toEqual(['tool.not_allowed']);
    // Case-insensitive match on the allow list.
    expect(evaluate({ permissions: permissions({ aiAllowedTools: ['TAP'] }) }).verdict).toBe('allow');
  });

  it('allows a plain supervised tap on a safe label', () => {
    expect(evaluate()).toEqual({ verdict: 'allow', risk: 'low', reasons: [], rules: [] });
    expect(evaluate({ actor: 'workflow', label: 'Wi-Fi' }).verdict).toBe('allow');
    expect(evaluate({ action: { kind: 'press_home' }, target: null }).verdict).toBe('allow');
  });

  it('notes unlabeled tap targets as medium risk but still allows them', () => {
    const d = evaluate({ label: null });
    expect(d).toMatchObject({ verdict: 'allow', risk: 'medium', rules: ['target.unlabeled'] });
    expect(evaluate({ label: '   ' }).rules).toEqual(['target.unlabeled']);
  });

  it('requires approval for every action in Assisted mode', () => {
    const d = evaluate({ mode: 'assisted' });
    expect(d).toMatchObject({ verdict: 'require_approval', risk: 'low', rules: ['mode.assisted'] });
    expect(evaluate({ mode: 'assisted', action: { kind: 'press_home' } }).verdict).toBe('require_approval');
    // A denial is never turned into an approval.
    const denied = evaluate({ mode: 'assisted', action: { kind: 'launch_app', name: 'Wallet' } });
    expect(denied.verdict).toBe('deny');
    expect(denied.rules).not.toContain('mode.assisted');
  });
});

describe('blocked apps', () => {
  it('denies launching a blocked app', () => {
    const d = evaluate({ action: { kind: 'launch_app', name: 'Wallet' } });
    expect(d).toMatchObject({ verdict: 'deny', risk: 'high', rules: ['blocked_app.launch'] });
    expect(evaluate({ action: { kind: 'launch_app', name: 'paypal' } }).rules).toEqual(['blocked_app.launch']);
    expect(evaluate({ action: { kind: 'launch_app', name: 'Bank of America' } }).rules).toEqual(['blocked_app.launch']);
    expect(evaluate({ action: { kind: 'launch_app', name: 'Settings' } }).verdict).toBe('allow');
  });

  it('matches whole words only ("Bank" does not block "Banking News")', () => {
    expect(evaluate({ action: { kind: 'launch_app', name: 'Banking News' } }).verdict).toBe('allow');
  });

  it('denies tapping a blocked app icon or its settings row', () => {
    const icon = evaluate({ label: 'Wallet' });
    expect(icon).toMatchObject({ verdict: 'deny', rules: ['blocked_app.target'] });

    const row = evaluate({ label: 'Wallet & Apple Pay' });
    expect(row.verdict).toBe('deny');
    expect(row.rules).toEqual(['blocked_app.target', 'sensitive.payment']);
    expect(row.risk).toBe('high');
  });

  it('denies typing the name of a blocked app (e.g. into Spotlight)', () => {
    const d = evaluate({ action: { kind: 'type_text', text: 'open Coinbase' }, target: null });
    expect(d.verdict).toBe('deny');
    expect(d.rules).toEqual(['blocked_app.typed']);
  });
});

describe('sensitive rules', () => {
  it('requires approval when a tap target matches a sensitive keyword', () => {
    const d = evaluate({ label: 'Delete Account' });
    expect(d).toMatchObject({ verdict: 'require_approval', risk: 'high', rules: ['sensitive.destructive'] });
    expect(d.reasons[0]).toContain('"delete"');
    expect(evaluate({ label: 'Send' }).rules).toEqual(['sensitive.messaging']);
    expect(evaluate({ label: 'Allow' }).rules).toEqual(['sensitive.security']);
    expect(evaluate({ label: 'Privacy & Security' }).rules).toEqual(['sensitive.security']);
  });

  it('matches Arabic keywords (substring match for non-Latin scripts)', () => {
    expect(evaluate({ label: 'حذف الحساب' }).rules).toEqual(['sensitive.destructive']);
    const typed = evaluate({ action: { kind: 'type_text', text: 'تم إرسال الرسالة' }, target: null });
    expect(typed).toMatchObject({ verdict: 'require_approval', rules: ['sensitive.messaging.text'] });
  });

  it('applies rules to typed text', () => {
    expect(evaluate({ action: { kind: 'type_text', text: 'please transfer 100' }, target: null }).rules).toEqual([
      'sensitive.payment.text',
    ]);
    expect(evaluate({ action: { kind: 'type_text', text: 'hello world' }, target: null }).verdict).toBe('allow');
  });

  it('denies outright when a rule has effect "deny" and ignores disabled rules', () => {
    const rules = [
      { id: 'no-buy', label: 'No purchases', keywords: ['buy'], effect: 'deny' as const, enabled: true },
      { id: 'off', label: 'Disabled', keywords: ['general'], effect: 'require_approval' as const, enabled: false },
    ];
    const p = permissions({ sensitiveRules: rules });
    expect(evaluate({ permissions: p, label: 'Buy Now' })).toMatchObject({ verdict: 'deny', rules: ['sensitive.no-buy'] });
    expect(evaluate({ permissions: p, label: 'General' }).verdict).toBe('allow');
    expect(evaluate({ permissions: p, action: { kind: 'type_text', text: 'buy it' }, target: null }).rules).toEqual([
      'sensitive.no-buy.text',
    ]);
  });
});

describe('authentication and payment screens', () => {
  const authScreen = { screenTexts: ['Enter Passcode', 'Cancel'] };

  it('denies typing on an auth prompt and asks approval for other actions', () => {
    const typing = evaluate({ action: { kind: 'type_text', text: '123456' }, target: null, context: authScreen });
    expect(typing).toMatchObject({ verdict: 'deny', rules: ['auth.typing'] });
    expect(typing.reasons[0]).toContain('Enter Passcode');

    const tap = evaluate({ label: 'Cancel', context: authScreen });
    expect(tap).toMatchObject({ verdict: 'require_approval', risk: 'high', rules: ['screen.auth'] });
    expect(evaluate({ action: { kind: 'press_home' }, target: null, context: authScreen }).rules).toEqual(['screen.auth']);
  });

  it('recognises other credential prompts (verification code, Apple Account password, Arabic)', () => {
    for (const text of ['Enter the verification code sent to your phone', 'Apple Account Password', 'One-time code', 'أدخل رمز التحقق']) {
      expect(evaluate({ action: { kind: 'type_text', text: 'abc' }, target: null, context: { screenTexts: [text] } }).rules).toContain(
        'auth.typing',
      );
    }
  });

  it('denies typing into a field that looks like a secret', () => {
    expect(evaluate({ action: { kind: 'type_text', text: 'hunter2' }, label: 'Password' }).rules).toEqual(['auth.field']);
    expect(evaluate({ action: { kind: 'type_text', text: '0000' }, label: 'PIN' }).rules).toEqual(['auth.field']);
  });

  it('lets typing through on auth screens when blockTypingOnAuthScreens is off', () => {
    const p = permissions({ blockTypingOnAuthScreens: false });
    expect(evaluate({ permissions: p, action: { kind: 'type_text', text: 'hello' }, label: 'Password', context: authScreen }).verdict).toBe(
      'allow',
    );
    // Other actions still need approval on that screen.
    expect(evaluate({ permissions: p, label: 'OK', context: authScreen }).rules).toEqual(['screen.auth']);
  });

  it('requires approval on a payment sheet', () => {
    const d = evaluate({ label: 'Continue', context: { screenTexts: ['Apple Pay', 'Double Click to Pay'] } });
    expect(d).toMatchObject({ verdict: 'require_approval', risk: 'high', rules: ['screen.payment'] });
    expect(evaluate({ label: 'Done', context: { screenTexts: ['Card Number', 'CVV'] } }).rules).toEqual(['screen.payment']);
  });
});

describe('commit after typing', () => {
  const typed = { pendingTypedText: true };

  it('requires approval for Return after typing (any case), not without typing', () => {
    expect(evaluate({ action: { kind: 'press_key', key: 'return' }, target: null, context: typed }).rules).toEqual(['commit.after_typing']);
    expect(evaluate({ action: { kind: 'press_key', key: 'Enter' }, target: null, context: typed }).verdict).toBe('require_approval');
    expect(evaluate({ action: { kind: 'press_key', key: 'return' }, target: null }).verdict).toBe('allow');
    expect(evaluate({ action: { kind: 'press_key', key: 'delete' }, target: null, context: typed }).verdict).toBe('allow');
  });

  it('requires approval for an unlabeled tap (e.g. the send arrow) after typing', () => {
    const d = evaluate({ label: null, context: typed });
    expect(d.verdict).toBe('require_approval');
    expect(d.rules).toEqual(['target.unlabeled', 'commit.after_typing']);
  });

  it('requires approval for "Send"-like labels after typing', () => {
    const send = evaluate({ label: 'Send', context: typed });
    expect(send.rules).toEqual(['sensitive.messaging', 'commit.after_typing']);
    for (const label of ['Done', 'Go', 'Search', 'OK', 'Continue', 'Next', 'Submit']) {
      expect(evaluate({ label, context: typed }).rules).toContain('commit.after_typing');
    }
  });

  it('allows a safe label after typing in supervised mode', () => {
    expect(evaluate({ label: 'Notes', context: typed }).verdict).toBe('allow');
    expect(evaluate({ label: 'Cancel Guest', context: typed }).verdict).toBe('allow');
  });
});

describe('URLs', () => {
  const withUrl = permissions({ aiAllowedTools: [...createDefaultSettings().permissions.aiAllowedTools, 'open_url'] });
  const url = (u: string) => evaluate({ permissions: withUrl, action: { kind: 'open_url', url: u }, target: null });

  it('allows http and https', () => {
    expect(url('https://example.com/path?q=1').verdict).toBe('allow');
    expect(url('http://example.com').verdict).toBe('allow');
  });

  it('never opens javascript:, data: or file: URLs', () => {
    for (const u of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd']) {
      expect(url(u)).toMatchObject({ verdict: 'deny', rules: ['url.scheme_denied'] });
    }
  });

  it('asks before opening other schemes that start calls, messages or apps', () => {
    for (const u of ['tel:+15555550100', 'sms:+15555550100', 'shortcuts://run-shortcut?name=x']) {
      expect(url(u)).toMatchObject({ verdict: 'require_approval', risk: 'high', rules: ['url.scheme'] });
    }
  });

  it('flags links mentioning a blocked app and denies unparsable URLs', () => {
    expect(url('https://wallet.example.com/pay').rules).toEqual(['url.blocked_app']);
    expect(url('not a url')).toMatchObject({ verdict: 'deny', rules: ['url.invalid'] });
  });
});

describe('text helpers', () => {
  it('containsKeyword matches whole words only for Latin text', () => {
    expect(containsKeyword('Send', 'send')).toBe(true);
    expect(containsKeyword('Send Message', 'send')).toBe(true);
    expect(containsKeyword('Sender', 'send')).toBe(false);
    expect(containsKeyword('Resend', 'send')).toBe(false);
    expect(containsKeyword('send-later', 'send')).toBe(true);
    expect(containsKeyword('Apple  Pay', 'apple pay')).toBe(true);
    expect(containsKeyword('Don’t Allow', "don't allow")).toBe(true);
    expect(containsKeyword('anything', '   ')).toBe(false);
    // Regex metacharacters in keywords are matched literally.
    expect(containsKeyword('Pay (now)', '(now)')).toBe(true);
    expect(containsKeyword('Pay now', '(now)')).toBe(false);
  });

  it('containsKeyword uses substring matching for Arabic', () => {
    expect(containsKeyword('سيتم الحذف الآن', 'حذف')).toBe(true);
    expect(containsKeyword('إرسال', 'إرسال')).toBe(true);
  });

  it('normalizeText folds case, width and whitespace', () => {
    expect(normalizeText('  ＡＢＣ\n  def’s ')).toBe("abc def's");
  });

  it('matchesBlockedApp and matchSensitiveRules report what matched', () => {
    expect(matchesBlockedApp('Open Wallet now', ['PayPal', 'Wallet'])).toBe('Wallet');
    expect(matchesBlockedApp('Notes', ['Wallet'])).toBeNull();
    const hits = matchSensitiveRules('Delete and send', createDefaultSettings().permissions.sensitiveRules);
    expect(hits.map((h) => [h.rule.id, h.keyword])).toEqual([
      ['messaging', 'send'],
      ['destructive', 'delete'],
    ]);
  });

  it('screen detectors return the matching text', () => {
    expect(screenHasAuthPrompt(['Settings', 'Enter your password'])).toBe('Enter your password');
    expect(screenHasAuthPrompt(['Passwords', 'Wi-Fi'])).toBeNull();
    expect(screenHasPaymentSheet(['Confirm with Side Button'])).toBe('Confirm with Side Button');
    expect(screenHasPaymentSheet(['Pay'])).toBeNull();
  });
});

describe('launch names that Spotlight resolves to a blocked app', () => {
  const launch = (name: string) => evaluate({ action: { kind: 'launch_app', name }, target: null });

  it('denies fragments, spellings and diacritic variants of blocked app names', () => {
    for (const name of ['Walle', 'Wall', 'wallet', 'WALLÉT', 'Rajhi', 'alrajhi', 'Al-Rajhi', '1Pass', 'Authentica', 'Google Auth', 'Coinbas', 'PayPa', 'Venm', 'Passwor']) {
      expect(launch(name), name).toMatchObject({ verdict: 'deny', rules: ['blocked_app.launch'] });
    }
  });

  it('still allows ordinary apps (and whole-word containment stays whole-word)', () => {
    for (const name of ['Settings', 'Safari', 'Messages', 'Photos', 'Wallpaper', 'App Store', 'Banking News', 'Gmail']) {
      expect(launch(name).verdict, name).toBe('allow');
    }
  });

  it('asks before opening a whole word of a longer blocked name, or a very short name', () => {
    expect(launch('Google')).toMatchObject({ verdict: 'require_approval', rules: ['launch.partial_blocked_name'] });
    expect(launch('Microsoft').rules).toEqual(['launch.partial_blocked_name']);
    expect(launch('TV')).toMatchObject({ verdict: 'require_approval', rules: ['launch.short_name'] });
  });

  it('denies names with control or invisible characters', () => {
    expect(launch('Wal​let')).toMatchObject({ verdict: 'deny', rules: ['launch.invalid_name'] });
    expect(launch('Notes\n')).toMatchObject({ verdict: 'deny', rules: ['launch.invalid_name'] });
  });

  it('checkLaunchName reports what matched', () => {
    const blocked = permissions().blockedApps;
    expect(checkLaunchName('Walle', blocked)).toEqual({ kind: 'blocked', app: 'Wallet' });
    expect(checkLaunchName('Google', blocked)).toEqual({ kind: 'partial_word', app: 'Google Authenticator' });
    expect(checkLaunchName('Settings', blocked)).toBeNull();
  });

  it('denies typing a fragment of a blocked name into Spotlight, but not elsewhere', () => {
    const type = (text: string, screenTexts: string[]) => evaluate({ action: { kind: 'type_text', text }, target: null, context: { screenTexts } });
    expect(type('Walle', ['Siri Suggestions', 'Settings'])).toMatchObject({ verdict: 'deny', rules: ['blocked_app.typed'] });
    expect(type('Walle', ['Top Hit', 'Wallet'])).toMatchObject({ verdict: 'deny', rules: ['blocked_app.typed'] });
    expect(type('Walle', ['Notes', 'New Note']).verdict).toBe('allow');
  });
});

describe('a blocked app already on screen', () => {
  const header = { blockedForeground: { app: 'Wallet', label: 'Wallet', where: 'header' as const } };
  const topHit = { blockedForeground: { app: 'Wallet', label: 'Wallet', where: 'top_hit' as const } };

  it('requires approval for every action inside it except leaving', () => {
    expect(evaluate({ label: 'Apple Cash', context: header })).toMatchObject({ verdict: 'require_approval', rules: ['blocked_app.foreground'] });
    expect(evaluate({ action: { kind: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4 }, target: null, context: header }).rules).toEqual([
      'blocked_app.foreground',
    ]);
    expect(evaluate({ action: { kind: 'press_home' }, target: null, context: header }).verdict).toBe('allow');
    expect(evaluate({ action: { kind: 'launch_app', name: 'Settings' }, target: null, context: header }).verdict).toBe('allow');
  });

  it("denies Return when Spotlight's top hit is a blocked app", () => {
    expect(evaluate({ action: { kind: 'press_key', key: 'return' }, target: null, context: topHit })).toMatchObject({
      verdict: 'deny',
      rules: ['blocked_app.top_hit'],
    });
    expect(evaluate({ action: { kind: 'press_key', key: 'delete' }, target: null, context: topHit }).verdict).toBe('allow');
  });
});

describe('line breaks and control characters in typed text', () => {
  const type = (text: string) => evaluate({ action: { kind: 'type_text', text }, target: null });

  it('treats a line break as a commit that needs approval (Mirroir types it as Return)', () => {
    for (const text of ['On my way\n', 'x\r', 'x\r\n', 'a\nb']) {
      expect(type(text), JSON.stringify(text)).toMatchObject({ verdict: 'require_approval', risk: 'high', rules: ['commit.in_text'] });
    }
    // Also when nothing was typed before, and in Assisted mode alongside the mode rule.
    expect(evaluate({ mode: 'assisted', action: { kind: 'type_text', text: 'hi\n' }, target: null }).rules).toEqual([
      'commit.in_text',
      'mode.assisted',
    ]);
  });

  it('denies raw control characters and asks before a Tab', () => {
    expect(type('ding\u0007')).toMatchObject({ verdict: 'deny', rules: ['text.control_chars'] });
    expect(type('a\u001bb').verdict).toBe('deny');
    expect(type('name\tvalue')).toMatchObject({ verdict: 'require_approval', rules: ['text.tab'] });
    expect(type('plain text').verdict).toBe('allow');
  });
});

describe('coordinate taps that may hit a labelled control', () => {
  // Right side of a full-width row: no label within reach, the row's label is a candidate.
  const tapWith = (candidates: string[], nearby: string[] = []) =>
    evaluate({ action: { kind: 'tap', x: 380, y: 818 }, target: { label: null, candidates, nearby } });

  it('applies blocked-app and sensitive rules to every candidate label', () => {
    const wallet = tapWith(['Wallet & Apple Pay']);
    expect(wallet).toMatchObject({ verdict: 'deny', rules: ['blocked_app.target', 'sensitive.payment', 'target.unlabeled'] });
    expect(wallet.reasons[0]).toContain('may hit "Wallet & Apple Pay"');
    expect(tapWith(['Privacy & Security'])).toMatchObject({ verdict: 'require_approval', rules: ['sensitive.security', 'target.unlabeled'] });
    const second = evaluate({ action: { kind: 'tap', x: 110, y: 412 }, target: { label: 'Health', candidates: ['Health', 'Wallet'] } });
    expect(second).toMatchObject({ verdict: 'deny', rules: ['blocked_app.target'] });
    expect(second.reasons[0]).toContain('may hit "Wallet"');
    expect(tapWith(['General']).verdict).toBe('allow');
  });

  it('a row candidate does not make an unlabeled target safe after typing (the send arrow next to the draft)', () => {
    const d = evaluate({ action: { kind: 'tap', x: 378, y: 800 }, target: { label: null, candidates: ['I quit'] }, context: { pendingTypedText: true } });
    expect(d).toMatchObject({ verdict: 'require_approval', rules: ['target.unlabeled', 'commit.after_typing'] });
  });

  it('asks before a blind tap right next to sensitive or blocked text', () => {
    expect(tapWith([], ['Delete'])).toMatchObject({ verdict: 'require_approval', rules: ['target.unlabeled', 'target.unlabeled_near_sensitive'] });
    expect(tapWith([], ['Wallet']).rules).toContain('target.unlabeled_near_sensitive');
    expect(tapWith([], ['Notes'])).toMatchObject({ verdict: 'allow', rules: ['target.unlabeled'] });
  });

  it('commit-after-typing checks every candidate', () => {
    const d = evaluate({ target: { label: 'Notes', candidates: ['Notes', 'Send'] }, context: { pendingTypedText: true } });
    expect(d.rules).toContain('commit.after_typing');
  });
});

describe('one-time code screens', () => {
  it('recognises "Enter the 6-digit code" style prompts', () => {
    for (const text of ['Enter the 6-digit code we sent to +966…', 'Enter the code', 'Your sign-in code', 'Use the 4 digit code']) {
      expect(evaluate({ action: { kind: 'type_text', text: '123456' }, target: null, context: { screenTexts: [text] } }).rules, text).toContain(
        'auth.typing',
      );
    }
  });
});
