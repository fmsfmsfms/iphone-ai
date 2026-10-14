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

export interface PolicyTarget {
  /** Visible text of the element being acted on (from describe_screen), if known. */
  label: string | null;
  elementId?: string | null;
}

export interface PolicyContext {
  /** The actor typed text that has not been committed (sent/submitted) and approved yet. */
  pendingTypedText?: boolean;
  /** Texts visible on the latest observation of the screen. */
  screenTexts?: readonly string[];
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
    if (containsKeyword(text, app)) return app;
  }
  return null;
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

function isPointerAction(action: DeviceAction): action is Extract<DeviceAction, { x: number }> {
  return action.kind === 'tap' || action.kind === 'double_tap' || action.kind === 'long_press';
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { actor, action, permissions } = input;
  const d = new DecisionBuilder();
  const tool = ACTION_TOOL[action.kind];

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
  const screenTexts = input.context?.screenTexts ?? [];

  switch (action.kind) {
    case 'launch_app': {
      const hit = matchesBlockedApp(action.name, blocked);
      if (hit) d.deny('blocked_app.launch', `"${action.name}" is a blocked app (${hit}).`);
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
      const authText = screenHasAuthPrompt(screenTexts);
      if (permissions.blockTypingOnAuthScreens && authText) {
        d.deny('auth.typing', `The screen is asking for credentials or a code ("${authText}"). Enter it yourself on the iPhone.`);
      }
      if (targetLabel && permissions.blockTypingOnAuthScreens && /pass(word|code)|\bpin\b|\bcode\b|كلمة المرور|رمز/i.test(targetLabel)) {
        d.deny('auth.field', `Typing into "${targetLabel}" looks like entering a secret.`);
      }
      const app = matchesBlockedApp(action.text, blocked);
      if (app) d.deny('blocked_app.typed', `Typing the name of a blocked app (${app}) is not allowed.`);
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
      break;
    }
    default:
      break;
  }

  if (isPointerAction(action)) {
    if (targetLabel) {
      const app = matchesBlockedApp(targetLabel, blocked);
      if (app) d.deny('blocked_app.target', `"${targetLabel}" opens or belongs to a blocked app (${app}).`);
      for (const hit of matchSensitiveRules(targetLabel, rules)) {
        if (hit.rule.effect === 'deny') d.deny(`sensitive.${hit.rule.id}`, `"${targetLabel}" matches "${hit.keyword}" (${hit.rule.label}).`);
        else d.approval(`sensitive.${hit.rule.id}`, `"${targetLabel}" matches "${hit.keyword}" (${hit.rule.label}).`, 'high');
      }
    } else {
      d.note('target.unlabeled', 'The tap target has no readable label.', 'medium');
    }
    if (input.context?.pendingTypedText) {
      const labelIsSafe =
        targetLabel !== null &&
        matchSensitiveRules(targetLabel, rules).length === 0 &&
        !/\b(send|submit|post|reply|done|go|search|ok|confirm|continue|next)\b/i.test(targetLabel);
      if (!labelIsSafe) {
        d.approval('commit.after_typing', 'This tap may send or submit the text that was just typed.', 'high');
      }
    }
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

  return d.build();
}
