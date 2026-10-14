// Pure helpers for the Settings page: section routing, draft diffing and
// rebasing, validation (shared zod schemas → translated field errors), parsing
// API validation errors, network-address checks and provider/rule factories.

import {
  DEFAULT_PROVIDERS,
  providerConfigSchema,
  settingsPatchSchema,
  type AppSettings,
  type ProviderConfig,
  type SensitiveRule,
} from '@iphone-ai/shared';

export type SectionId = 'general' | 'connection' | 'providers' | 'permissions' | 'automation' | 'privacy' | 'remote' | 'advanced';

export const SECTION_IDS: readonly SectionId[] = ['general', 'connection', 'providers', 'permissions', 'automation', 'privacy', 'remote', 'advanced'];

/** Other names that link to a section (#/settings/ai is used by the shell). */
const SECTION_ALIASES: Record<string, SectionId> = {
  ai: 'providers',
  'ai-providers': 'providers',
  provider: 'providers',
  iphone: 'connection',
  mirroir: 'connection',
  safety: 'permissions',
  permission: 'permissions',
  automations: 'automation',
  workflows: 'automation',
  data: 'privacy',
  'remote-access': 'remote',
  diagnostics: 'advanced',
  developer: 'advanced',
};

/** Maps a route section (or alias) to a settings section; unknown values fall back to General. */
export function resolveSection(section: string | undefined | null): SectionId {
  const key = (section ?? '').trim().toLowerCase();
  if ((SECTION_IDS as readonly string[]).includes(key)) return key as SectionId;
  return SECTION_ALIASES[key] ?? 'general';
}

export type EditableSection = Exclude<keyof AppSettings, 'version'>;

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, i) => deepEqual(value, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Top-level keys whose draft value differs from the base (deep comparison), excluding `ignore`. */
export function diffSection<T extends object>(base: T, draft: T, ignore: readonly (keyof T)[] = []): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (ignore.includes(key)) continue;
    if (!deepEqual(base[key], draft[key])) patch[key] = draft[key];
  }
  return patch;
}

export function hasChanges<T extends object>(base: T, draft: T, ignore: readonly (keyof T)[] = []): boolean {
  return Object.keys(diffSection(base, draft, ignore)).length > 0;
}

/**
 * The server's copy changed while the user was editing: keep the keys the user
 * changed (draft ≠ base) and take the server's value for everything else.
 * Ignored keys always follow the server.
 */
export function rebaseDraft<T extends object>(base: T, draft: T, server: T, ignore: readonly (keyof T)[] = []): T {
  const next = { ...server };
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (ignore.includes(key)) continue;
    if (!deepEqual(base[key], draft[key])) next[key] = draft[key];
  }
  return next;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Field path (inside the section, dotted) → translated message. */
export type FieldErrors = Record<string, string>;

export type Translate = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

/** The subset of a zod issue the UI needs (works for zod 3 and 4 shapes). */
export interface IssueLike {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
  type?: string;
  format?: string;
  expected?: string;
}

function asNumber(value: number | bigint | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

/** Translates one validation issue. */
export function issueMessage(issue: IssueLike, t: Translate): string {
  const origin = issue.origin ?? issue.type;
  const min = asNumber(issue.minimum);
  const max = asNumber(issue.maximum);
  switch (issue.code) {
    case 'too_small':
      if (origin === 'string') return min !== undefined && min <= 1 ? t('settings.validation.required') : t('settings.validation.minLength', { min });
      if (origin === 'array') return t('settings.validation.minItems', { min });
      return t('settings.validation.min', { min });
    case 'too_big':
      if (origin === 'string') return t('settings.validation.maxLength', { max });
      if (origin === 'array') return t('settings.validation.maxItems', { max });
      return t('settings.validation.max', { max });
    case 'invalid_type':
      if (issue.expected === 'int' || /integer/i.test(issue.message)) return t('settings.validation.integer');
      if (issue.expected === 'number') return t('settings.validation.number');
      if (issue.expected === 'string') return t('settings.validation.required');
      return t('settings.validation.invalid');
    case 'invalid_format':
    case 'invalid_string':
      if (issue.format === 'url' || /url/i.test(issue.message)) return t('settings.validation.url');
      if (issue.format === 'regex') return t('settings.validation.pattern');
      return t('settings.validation.invalid');
    default:
      if (/integer/i.test(issue.message)) return t('settings.validation.integer');
      return t('settings.validation.invalid');
  }
}

function collectIssues(issues: readonly IssueLike[], t: Translate, dropPrefix: number): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const path = issue.path.slice(dropPrefix).map(String).join('.');
    const key = path || '_';
    if (!(key in errors)) errors[key] = issueMessage(issue, t);
  }
  return errors;
}

/** Validates a section patch with the same schema the backend uses. */
export function validateSectionPatch(section: EditableSection, patch: object, t: Translate): FieldErrors {
  if (Object.keys(patch).length === 0) return {};
  const result = settingsPatchSchema.safeParse({ [section]: patch });
  if (result.success) return {};
  return collectIssues(result.error.issues as unknown as IssueLike[], t, 1);
}

/** Validates a provider configuration before PUT/POST /api/providers. */
export function validateProvider(provider: ProviderConfig, t: Translate): FieldErrors {
  const errors: FieldErrors = {};
  const result = providerConfigSchema.safeParse(provider);
  if (!result.success) Object.assign(errors, collectIssues(result.error.issues as unknown as IssueLike[], t, 0));
  if (provider.kind === 'openai-compatible' && !provider.baseUrl && !errors['baseUrl']) errors['baseUrl'] = t('settings.validation.baseUrlRequired');
  if (provider.baseUrl && !errors['baseUrl']) {
    try {
      const protocol = new URL(provider.baseUrl).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') errors['baseUrl'] = t('settings.validation.url');
    } catch {
      errors['baseUrl'] = t('settings.validation.url');
    }
  }
  return errors;
}

/** First error for `path` or any nested path below it ("blockedApps" matches "blockedApps.3"). */
export function errorFor(errors: FieldErrors, path: string): string | null {
  if (errors[path]) return errors[path]!;
  const prefix = `${path}.`;
  for (const [key, message] of Object.entries(errors)) if (key.startsWith(prefix)) return message;
  return null;
}

/**
 * Splits an API validation message ("connection.screenshot.activeFps: Too
 * small; remote.port: …") into field errors for one section; anything that
 * cannot be attributed to a field is returned as general text.
 */
export function parseServerValidation(message: string, section: string): { fields: FieldErrors; general: string | null } {
  const fields: FieldErrors = {};
  const general: string[] = [];
  for (const part of message.split(/;\s+/)) {
    const match = /^([A-Za-z0-9_.]+):\s+(.+)$/.exec(part.trim());
    if (match && !section) {
      // Bodies that are not nested in a section (e.g. a provider): every path is a field.
      fields[match[1]!] ??= match[2]!;
    } else if (match && (match[1] === section || match[1]!.startsWith(`${section}.`))) {
      const path = match[1] === section ? '_' : match[1]!.slice(section.length + 1);
      fields[path] ??= match[2]!;
    } else if (part.trim()) {
      general.push(part.trim());
    }
  }
  return { fields, general: general.length ? general.join('; ') : null };
}

// ---------------------------------------------------------------------------
// Remote access
// ---------------------------------------------------------------------------

export type AddressKind = 'tailscale' | 'private' | 'loopback' | 'link-local' | 'public' | 'invalid';

/** Classifies an IPv4 address for the remote-access warning. */
export function classifyIPv4(address: string): AddressKind {
  const parts = address.trim().split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return 'invalid';
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (parts.map(Number).some((n) => n > 255)) return 'invalid';
  if (a === 127) return 'loopback';
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  return 'public';
}

export function isPrivateAddress(address: string): boolean {
  const kind = classifyIPv4(address);
  return kind === 'tailscale' || kind === 'private' || kind === 'link-local';
}

export function remoteUrlFor(address: string, port: number): string {
  return `http://${address}:${port}`;
}

export const MIN_PASSCODE_LENGTH = 8;

/** i18n key describing why a new passcode can't be saved (null when it can). */
export function passcodeProblem(passcode: string, confirm: string): string | null {
  if (passcode.length < MIN_PASSCODE_LENGTH) return 'settings.remote.passcode.tooShort';
  if (passcode.length > 128) return 'settings.remote.passcode.tooLong';
  if (passcode !== confirm) return 'settings.remote.passcode.mismatch';
  return null;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const BUILT_IN_IDS = new Set(DEFAULT_PROVIDERS.map((p) => p.id));
const RESERVED_IDS = new Set(['active', 'claude-code']);

export function isBuiltInProvider(id: string): boolean {
  return BUILT_IN_IDS.has(id);
}

/** A provider id (`[a-z0-9-]{2,40}`) derived from a label, unique among `existing`. */
export function providerIdFromLabel(label: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  let base = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (base.length < 2) base = 'custom';
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED_IDS.has(id) || BUILT_IN_IDS.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export interface CustomProviderInput {
  label: string;
  baseUrl: string;
  model: string;
  vision: boolean;
}

/** A new OpenAI-compatible provider (vLLM, a remote LM Studio, …). The backend recomputes `cloud` and `hasApiKey`. */
export function makeCustomProvider(input: CustomProviderInput, existingIds: Iterable<string>): ProviderConfig {
  const baseUrl = input.baseUrl.trim();
  return {
    id: providerIdFromLabel(input.label, existingIds),
    kind: 'openai-compatible',
    label: input.label.trim(),
    baseUrl,
    model: input.model.trim(),
    vision: input.vision,
    maxOutputTokens: 4096,
    contextTokens: 32768,
    timeoutMs: 180000,
    effort: null,
    enabled: true,
    hasApiKey: false,
    cloud: baseUrl ? !isLoopbackUrl(baseUrl) : true,
  };
}

/** Providers that authenticate with an API key stored in the Keychain. */
export function providerUsesApiKey(provider: Pick<ProviderConfig, 'kind'>): boolean {
  return provider.kind !== 'claude-agent-sdk';
}

/** Whether an API key is required (local OpenAI-compatible servers usually don't need one). */
export function providerRequiresApiKey(provider: Pick<ProviderConfig, 'kind'>): boolean {
  return provider.kind === 'anthropic' || provider.kind === 'openai';
}

export function providerSupportsEffort(provider: Pick<ProviderConfig, 'kind'>): boolean {
  return provider.kind === 'anthropic' || provider.kind === 'claude-agent-sdk';
}

export function providerUsesBaseUrl(provider: Pick<ProviderConfig, 'kind'>): boolean {
  return provider.kind !== 'claude-agent-sdk';
}

// ---------------------------------------------------------------------------
// Permissions editors
// ---------------------------------------------------------------------------

/** Adds an app name to the blocked list (trimmed, case-insensitive de-duplication). */
export function addBlockedApp(list: readonly string[], name: string): { list: string[]; added: boolean } {
  const value = name.trim().replace(/\s+/g, ' ');
  if (!value || value.length > 120) return { list: [...list], added: false };
  if (list.some((app) => app.toLowerCase() === value.toLowerCase())) return { list: [...list], added: false };
  return { list: [...list, value], added: true };
}

/** Splits a comma / newline separated keyword list (trimmed, de-duplicated, empty entries dropped). */
export function parseKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n،]/)) {
    const keyword = raw.trim();
    if (!keyword || keyword.length > 80) continue;
    const lower = keyword.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(keyword);
  }
  return out;
}

/** Rule id (`[a-z0-9-]{1,40}`) unique among existing rules. */
export function ruleIdFromLabel(label: string, existing: readonly SensitiveRule[]): string {
  const taken = new Set(existing.map((r) => r.id));
  let base = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!base) base = 'rule';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function toggleInList<T>(list: readonly T[], value: T, on: boolean): T[] {
  const without = list.filter((v) => v !== value);
  return on ? [...without, value] : without;
}
