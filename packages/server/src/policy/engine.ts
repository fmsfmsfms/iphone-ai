// Backend permission policy. Every AI and workflow action passes through
// evaluatePolicy() before it can reach Mirroir; manual actions are checked for
// the manual-control switch and the emergency stop. Mirroir's own fail-closed
// permission file is a second, independent layer (see permission-file.ts).
//
// The engine is a pure function so it can be exhaustively unit tested.

import {
  ACTION_TOOL,
  type Actor,
  type ControlMode,
  type DeviceAction,
  type PermissionSettings,
  type PolicyDecision,
  type RiskLevel,
  type SensitiveRule,
} from '@iphone-ai/shared';

import { isReadableLabel } from './target.js';

export { isReadableLabel };

export interface PolicyTarget {
  /** Visible text of the element being acted on (from describe_screen), if known. */
  label: string | null;
  elementId?: string | null;
  /**
   * Other labels a coordinate tap may hit (OCR gives text centres only, so a
   * tap on the right side of a full-width row is far from its label). Every
   * candidate gets the same blocked-app and sensitive checks as the label.
   */
  candidates?: readonly string[];
  /** Labels near an unlabeled target (approval only, never a denial). */
  nearby?: readonly string[];
}

/** A blocked app that appears to be in front (see policy/foreground.ts). */
export interface BlockedForeground {
  app: string;
  /** The on-screen text that matched. */
  label: string;
  /** 'header': title area of the current app; 'top_hit': Spotlight's Top Hit. */
  where: 'header' | 'top_hit';
}

export interface PolicyContext {
  /** The actor typed text that has not been committed (sent/submitted) and approved yet. */
  pendingTypedText?: boolean;
  /** Texts visible on the latest observation of the screen. */
  screenTexts?: readonly string[];
  /** A blocked app detected on the latest observation of the screen. */
  blockedForeground?: BlockedForeground | null;
}

export interface PolicyInput {
  actor: Actor;
  action: DeviceAction;
  mode: ControlMode;
  permissions: PermissionSettings;
  stopLatched: boolean;
  /** Remote sessions must be explicitly granted control. */
  remoteControlAllowed?: boolean;
  target?: PolicyTarget | null;
  context?: PolicyContext;
}

/** Strong signals that the phone is asking for credentials or a one-time code. */
const AUTH_PROMPT_PATTERNS: readonly RegExp[] = [
  /\benter (your )?(passcode|password|pin|code)\b/i,
  /\b(apple (account|id)|icloud) password\b/i,
  /\bverification code\b/i,
  /\bone[- ]time (pass)?code\b/i,
  /\bsecurity code\b/i,
  /\b(otp|2fa)\b/i,
  /\btwo[- ]factor\b/i,
  /\bpasscode required\b/i,
  /\benter the (\d+[- ]digit )?code\b/i,
  /\b\d+[- ]digit code\b/i,
  /\b(sign[- ]in|log[- ]in) code\b/i,
  /رمز التحقق/,
  /أدخل (رمز|كلمة)/,
];

/** Payment sheets and card-entry screens. */
const PAYMENT_SCREEN_PATTERNS: readonly RegExp[] = [
  /\bdouble[- ]click to pay\b/i,
  /\bconfirm with side button\b/i,
  /\bpay with passcode\b/i,
  /\bcard number\b/i,
  /\bcvv\b|\bcvc\b/i,
  /\bconfirm (payment|purchase|transfer)\b/i,
];

const SAFE_URL_SCHEMES = new Set(['http:', 'https:']);
const COMMIT_KEYS = new Set(['return', 'enter']);

/** C0/C1 control characters and invisible formatting characters (zero-width, bidi overrides, BOM). */
const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
/** Control characters Mirroir would send as raw keys, except Tab / Return / line feed (handled separately). */
const RAW_KEY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Launch names shorter than this (letters/digits only) match too many apps in Spotlight. */
const MIN_LAUNCH_NAME = 3;
/** Texts that only Spotlight's results page shows. */
const SPOTLIGHT_MARKERS = /^(top hit|siri suggestions|search web|search in apps)$/i;

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-word, case-insensitive containment (substring for non-Latin scripts). */
export function containsKeyword(haystack: string, keyword: string): boolean {
  const h = normalizeText(haystack);
  const k = normalizeText(keyword);
  if (!k) return false;
  if (/^[\x20-\x7e]+$/.test(k)) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(h);
  }
  return h.includes(k);
}

export function matchesBlockedApp(text: string, blockedApps: readonly string[]): string | null {
  for (const app of blockedApps) {
    if (containsKeyword(foldDiacritics(text), foldDiacritics(app))) return app;
  }
  return null;
}

/** Case- and diacritic-insensitive form ("Wallét" → "wallet"). */
export function foldDiacritics(value: string): string {
  return normalizeText(value.normalize('NFKD').replace(/\p{M}+/gu, ''));
}

/** Letters and digits only, folded ("Al-Rajhi" → "alrajhi"). */
function compactName(value: string): string {
  return foldDiacritics(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

export type LaunchNameHit =
  | { kind: 'blocked'; app: string }
  | { kind: 'partial_word'; app: string }
  | { kind: 'short' };

/**
 * Mirroir's launch_app types the name into Spotlight and presses Return, which
 * opens Spotlight's Top Hit — so a fragment of a blocked app's name opens the
 * blocked app. Compares in both directions, ignoring case, diacritics, spaces
 * and punctuation:
 *  • the name contains a blocked app (whole word) or equals it → blocked;
 *  • the name is a fragment of a blocked app's name ("Walle", "1Pass") → blocked;
 *  • the name is one or more whole words of a longer blocked name ("Google" of
 *    "Google Authenticator") → partial_word (approval: it is also a real app);
 *  • fewer than 3 letters/digits → short (approval: Spotlight could pick anything).
 */
export function checkLaunchName(name: string, blockedApps: readonly string[]): LaunchNameHit | null {
  const whole = matchesBlockedApp(name, blockedApps);
  if (whole) return { kind: 'blocked', app: whole };
  const query = compactName(name);
  let partial: string | null = null;
  for (const app of blockedApps) {
    const target = compactName(app);
    if (!target) continue;
    if (query === target) return { kind: 'blocked', app };
    if (query.length < MIN_LAUNCH_NAME || !target.includes(query)) continue;
    const words = foldDiacritics(app).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (isWordRun(words, query)) partial ??= app;
    else return { kind: 'blocked', app };
  }
  if (partial) return { kind: 'partial_word', app: partial };
  if (query.length < MIN_LAUNCH_NAME) return { kind: 'short' };
  return null;
}

/** True when `query` equals a run of whole consecutive words of the name. */
function isWordRun(words: readonly string[], query: string): boolean {
  for (let start = 0; start < words.length; start += 1) {
    let joined = '';
    for (let end = start; end < words.length; end += 1) {
      joined += words[end];
      if (joined === query) return true;
      if (joined.length >= query.length) break;
    }
  }
  return false;
}

/** The screen is Spotlight's search page (typing there + Return opens the Top Hit). */
export function screenLooksLikeSpotlight(texts: readonly string[]): boolean {
  return texts.some((t) => SPOTLIGHT_MARKERS.test(t.trim()));
}

export function matchSensitiveRules(
  text: string,
  rules: readonly SensitiveRule[],
): { rule: SensitiveRule; keyword: string }[] {
  const hits: { rule: SensitiveRule; keyword: string }[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const keyword = rule.keywords.find((k) => containsKeyword(text, k));
    if (keyword) hits.push({ rule, keyword });
  }
  return hits;
}

export function screenHasAuthPrompt(texts: readonly string[]): string | null {
  for (const text of texts) {
    for (const pattern of AUTH_PROMPT_PATTERNS) {
      if (pattern.test(text)) return text;
    }
  }
  return null;
}

export function screenHasPaymentSheet(texts: readonly string[]): string | null {
  for (const text of texts) {
    for (const pattern of PAYMENT_SCREEN_PATTERNS) {
      if (pattern.test(text)) return text;
    }
  }
  return null;
}

class DecisionBuilder {
  private verdict: PolicyDecision['verdict'] = 'allow';
  private risk: RiskLevel = 'low';
  private readonly reasons: string[] = [];
  private readonly rules: string[] = [];

  deny(rule: string, reason: string): this {
    this.verdict = 'deny';
    this.raise('high');
    this.add(rule, reason);
    return this;
  }

  approval(rule: string, reason: string, risk: RiskLevel = 'medium'): this {
    if (this.verdict !== 'deny') this.verdict = 'require_approval';
    this.raise(risk);
    this.add(rule, reason);
    return this;
  }

  note(rule: string, reason: string, risk: RiskLevel): this {
    this.raise(risk);
    this.add(rule, reason);
    return this;
  }

  /** Lets an action that would need approval run as is; the rules that fired stay for the audit log. */
  waiveApprovals(): this {
    if (this.verdict === 'require_approval') this.verdict = 'allow';
    return this;
  }

  get denied(): boolean {
    return this.verdict === 'deny';
  }

  build(): PolicyDecision {
    return { verdict: this.verdict, risk: this.risk, reasons: [...this.reasons], rules: [...this.rules] };
  }

  private add(rule: string, reason: string): void {
    if (!this.rules.includes(rule)) {
      this.rules.push(rule);
      this.reasons.push(reason);
    }
  }

  private raise(risk: RiskLevel): void {
    const order: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
    if (order[risk] > order[this.risk]) this.risk = risk;
  }
}

function uniqueLabels(labels: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw?.trim();
    if (label && !out.some((l) => normalizeText(l) === normalizeText(label))) out.push(label);
  }
  return out;
}

function isPointerAction(action: DeviceAction): action is Extract<DeviceAction, { x: number }> {
  return action.kind === 'tap' || action.kind === 'double_tap' || action.kind === 'long_press';
}

/** The entry of the allowed-AI-tools list that governs an action. */
export function allowedToolFor(action: DeviceAction): string {
  return ACTION_TOOL[action.kind];
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { actor, action, permissions } = input;
  const d = new DecisionBuilder();
  const tool = allowedToolFor(action);

  if (input.stopLatched) {
    return d.deny('stop.latched', 'Emergency stop is engaged. Re-arm control to continue.').build();
  }

  // ── Manual control by the person in front of the Mac (or an authorised remote session).
  if (actor === 'user' || actor === 'remote-user') {
    if (!permissions.manualControlEnabled) {
      d.deny('manual.disabled', 'Manual control is turned off. Enable it in Live Control.');
    }
    if (actor === 'remote-user' && !input.remoteControlAllowed) {
      d.deny('remote.view_only', 'This remote session is view-only.');
    }
    return d.build();
  }

  if (actor === 'system') {
    return d.deny('actor.system', 'System actors cannot perform device input.').build();
  }

  // ── AI and workflows.
  if (input.mode === 'observe') {
    d.deny('mode.observe', 'Observe Only mode: the AI may look at the screen but cannot interact with the iPhone.');
    return d.build();
  }

  const allowedTools = new Set(permissions.aiAllowedTools.map((t) => t.toLowerCase()));
  if (!allowedTools.has(tool)) {
    d.deny('tool.not_allowed', `The "${tool}" action is not in the allowed AI actions list.`);
    return d.build();
  }

  const blocked = permissions.blockedApps;
  const rules = permissions.sensitiveRules;
  const targetLabel = input.target?.label?.trim() || null;
  // OCR reads icons as stray glyphs ("a", "@", "X"): such a label does not make a target known.
  const readableTarget = targetLabel && isReadableLabel(targetLabel) ? targetLabel : null;
  const screenTexts = input.context?.screenTexts ?? [];

  switch (action.kind) {
    case 'launch_app': {
      if (INVISIBLE_OR_CONTROL.test(action.name)) {
        d.deny('launch.invalid_name', 'App names cannot contain control or invisible characters.');
        break;
      }
      const hit = checkLaunchName(action.name, blocked);
      if (hit?.kind === 'blocked') {
        d.deny('blocked_app.launch', `"${action.name}" is or would open a blocked app (${hit.app}) — Spotlight opens its top hit.`);
      } else if (hit?.kind === 'partial_word') {
        d.approval('launch.partial_blocked_name', `"${action.name}" is part of a blocked app's name (${hit.app}); Spotlight may open that app.`, 'high');
      } else if (hit?.kind === 'short') {
        d.approval('launch.short_name', `"${action.name}" is too short to say which app Spotlight will open.`, 'medium');
      }
      break;
    }
    case 'open_url': {
      let scheme = '';
      try {
        scheme = new URL(action.url).protocol;
      } catch {
        d.deny('url.invalid', 'The URL could not be parsed.');
        break;
      }
      if (scheme === 'javascript:' || scheme === 'data:' || scheme === 'file:') {
        d.deny('url.scheme_denied', `URLs with the ${scheme} scheme are never opened.`);
      } else if (!SAFE_URL_SCHEMES.has(scheme)) {
        d.approval('url.scheme', `Opening a ${scheme} link can start calls, messages or other apps.`, 'high');
      }
      const hit = matchesBlockedApp(action.url, blocked);
      if (hit) d.approval('url.blocked_app', `The link mentions a blocked app (${hit}).`, 'high');
      break;
    }
    case 'type_text': {
      if (RAW_KEY_CONTROL.test(action.text)) {
        d.deny('text.control_chars', 'The text contains control characters that would be sent as raw keys.');
      }
      if (/[\r\n]/.test(action.text)) {
        d.approval('commit.in_text', 'The text contains a line break. It is typed as Return, which may send or submit what was typed.', 'high');
      }
      if (action.text.includes('\t')) {
        d.approval('text.tab', 'The text contains a Tab, which moves focus to another field or control.', 'medium');
      }
      const authText = screenHasAuthPrompt(screenTexts);
      if (permissions.blockTypingOnAuthScreens && authText) {
        d.deny('auth.typing', `The screen is asking for credentials or a code ("${authText}"). Enter it yourself on the iPhone.`);
      }
      if (targetLabel && permissions.blockTypingOnAuthScreens && /pass(word|code)|\bpin\b|\bcode\b|كلمة المرور|رمز/i.test(targetLabel)) {
        d.deny('auth.field', `Typing into "${targetLabel}" looks like entering a secret.`);
      }
      const app = matchesBlockedApp(action.text, blocked);
      if (app) d.deny('blocked_app.typed', `Typing the name of a blocked app (${app}) is not allowed.`);
      else if (screenLooksLikeSpotlight(screenTexts)) {
        // In Spotlight a fragment of a blocked name is as good as the name (Return opens the Top Hit).
        const hit = checkLaunchName(action.text, blocked);
        if (hit?.kind === 'blocked') d.deny('blocked_app.typed', `Typing "${action.text}" into Spotlight would find a blocked app (${hit.app}).`);
        else if (hit?.kind === 'partial_word') {
          d.approval('blocked_app.typed_partial', `"${action.text}" is part of a blocked app's name (${hit.app}).`, 'high');
        }
      }
      for (const hit of matchSensitiveRules(action.text, rules)) {
        if (hit.rule.effect === 'deny') d.deny(`sensitive.${hit.rule.id}.text`, `Typed text matches "${hit.keyword}" (${hit.rule.label}).`);
        else d.approval(`sensitive.${hit.rule.id}.text`, `Typed text matches "${hit.keyword}" (${hit.rule.label}).`, 'high');
      }
      break;
    }
    case 'press_key': {
      if (COMMIT_KEYS.has(action.key.toLowerCase()) && input.context?.pendingTypedText) {
        d.approval('commit.after_typing', 'Pressing Return after typing may send or submit what was typed.', 'high');
      }
      const foreground = input.context?.blockedForeground;
      if (COMMIT_KEYS.has(action.key.toLowerCase()) && foreground?.where === 'top_hit') {
        d.deny('blocked_app.top_hit', `Return would open Spotlight's top hit "${foreground.label}", a blocked app (${foreground.app}).`);
      }
      break;
    }
    default:
      break;
  }

  if (isPointerAction(action)) {
    // The label plus every other label the tap may hit, all checked the same way.
    const labels = uniqueLabels([targetLabel, ...(input.target?.candidates ?? [])]);
    for (const label of labels) {
      const subject = label === targetLabel ? `"${label}"` : `The tap may hit "${label}", which`;
      const app = matchesBlockedApp(label, blocked);
      if (app) d.deny('blocked_app.target', `${subject} opens or belongs to a blocked app (${app}).`);
      for (const hit of matchSensitiveRules(label, rules)) {
        const text = `${subject} matches "${hit.keyword}" (${hit.rule.label}).`;
        if (hit.rule.effect === 'deny') d.deny(`sensitive.${hit.rule.id}`, text);
        else d.approval(`sensitive.${hit.rule.id}`, text, 'high');
      }
    }
    if (!readableTarget) d.note('target.unlabeled', 'The tap target has no readable label.', 'medium');
    if (!labels.some(isReadableLabel)) {
      // A blind tap right next to sensitive or blocked text needs a human look.
      for (const label of uniqueLabels(input.target?.nearby ?? [])) {
        const app = matchesBlockedApp(label, blocked);
        const hit = matchSensitiveRules(label, rules)[0];
        if (app || hit) {
          d.approval(
            'target.unlabeled_near_sensitive',
            `The unlabeled target is next to "${label}" (${app ? `blocked app ${app}` : hit!.rule.label}).`,
            'high',
          );
          break;
        }
      }
    }
    if (input.context?.pendingTypedText) {
      // Only a tap ON a readable, harmless label is safe; a row-band candidate (e.g. the
      // draft text next to an unlabeled send arrow) does not make the target known.
      const labelIsSafe =
        readableTarget !== null &&
        labels.every(
          (label) =>
            matchSensitiveRules(label, rules).length === 0 &&
            !/\b(send|submit|post|reply|done|go|search|ok|confirm|continue|next)\b/i.test(label),
        );
      if (!labelIsSafe) {
        d.approval('commit.after_typing', 'This tap may send or submit the text that was just typed.', 'high');
      }
    }
  }

  // A blocked app appears to be open: only leaving it (Home, or opening another app) runs without approval.
  const foreground = input.context?.blockedForeground;
  if (foreground?.where === 'header' && action.kind !== 'press_home' && action.kind !== 'launch_app') {
    d.approval(
      'blocked_app.foreground',
      `A blocked app (${foreground.app}) appears to be open ("${foreground.label}"). Actions inside it need your approval; going Home does not.`,
      'high',
    );
  }

  if (action.kind !== 'type_text') {
    const auth = screenHasAuthPrompt(screenTexts);
    if (auth) d.approval('screen.auth', `The screen shows an authentication prompt ("${auth}").`, 'high');
  }
  const payment = screenHasPaymentSheet(screenTexts);
  if (payment) d.approval('screen.payment', `The screen looks like a payment or card form ("${payment}").`, 'high');

  if (!d.denied && input.mode === 'assisted') {
    d.approval('mode.assisted', 'Assisted Control: every action needs your approval.', 'low');
  }
  // AI Mode: the user chose full autonomy, so nothing waits for approval. Denials still apply.
  if (input.mode === 'supervised') d.waiveApprovals();

  return d.build();
}
