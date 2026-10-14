import { createDefaultSettings, DEFAULT_PROVIDERS } from '@iphone-ai/shared';
import { describe, expect, it } from 'vitest';

import {
  addBlockedApp,
  classifyIPv4,
  deepEqual,
  diffSection,
  errorFor,
  hasChanges,
  isPrivateAddress,
  issueMessage,
  makeCustomProvider,
  parseKeywords,
  parseServerValidation,
  passcodeProblem,
  providerIdFromLabel,
  rebaseDraft,
  remoteUrlFor,
  resolveSection,
  ruleIdFromLabel,
  toggleInList,
  validateProvider,
  validateSectionPatch,
  type Translate,
} from './helpers';

/** Echoes the key and variables so tests can assert which message was chosen. */
const t: Translate = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

describe('resolveSection', () => {
  it('maps ids, aliases and unknown values', () => {
    expect(resolveSection('connection')).toBe('connection');
    expect(resolveSection('ai')).toBe('providers');
    expect(resolveSection('AI')).toBe('providers');
    expect(resolveSection(undefined)).toBe('general');
    expect(resolveSection('nope')).toBe('general');
  });
});

describe('draft diffing', () => {
  it('compares deeply', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
  });

  it('returns only changed top-level keys, honouring ignored ones', () => {
    const base = createDefaultSettings().connection;
    const draft = { ...base, requestTimeoutMs: 30000, screenshot: { ...base.screenshot, activeFps: 4 } };
    expect(diffSection(base, draft)).toEqual({ requestTimeoutMs: 30000, screenshot: { ...base.screenshot, activeFps: 4 } });
    expect(diffSection(base, { ...base })).toEqual({});
    const perms = createDefaultSettings().permissions;
    expect(diffSection(perms, { ...perms, controlMode: 'supervised' }, ['controlMode'])).toEqual({});
    expect(hasChanges(perms, { ...perms, blockedApps: [...perms.blockedApps, 'Notes'] })).toBe(true);
  });

  it('rebases the draft on server changes without losing local edits', () => {
    const base = createDefaultSettings().privacy;
    const draft = { ...base, historyRetentionDays: 30 };
    const server = { ...base, storeScreenshots: true, cloudDisclosureAcknowledged: true };
    expect(rebaseDraft(base, draft, server)).toEqual({ ...server, historyRetentionDays: 30 });
    // Ignored keys always follow the server.
    const draft2 = { ...base, cloudDisclosureAcknowledged: true };
    expect(rebaseDraft(base, draft2, { ...base }, ['cloudDisclosureAcknowledged']).cloudDisclosureAcknowledged).toBe(false);
  });
});

describe('validation', () => {
  it('validates a section patch with the shared schema', () => {
    expect(validateSectionPatch('connection', {}, t)).toEqual({});
    expect(validateSectionPatch('connection', { requestTimeoutMs: 60000 }, t)).toEqual({});
    const base = createDefaultSettings().connection.screenshot;
    const errors = validateSectionPatch('connection', { requestTimeoutMs: 100, screenshot: { ...base, activeFps: 50 } }, t);
    expect(errors['requestTimeoutMs']).toBe('settings.validation.min:{"min":5000}');
    expect(errors['screenshot.activeFps']).toBe('settings.validation.max:{"max":10}');
    expect(validateSectionPatch('automation', { maxStepsPerRun: 2.5 }, t)['maxStepsPerRun']).toBe('settings.validation.integer');
    expect(validateSectionPatch('privacy', { historyRetentionDays: Number.NaN }, t)['historyRetentionDays']).toBeDefined();
    expect(validateSectionPatch('connection', { mirroirBinaryPath: '' }, t)['mirroirBinaryPath']).toBe('settings.validation.required');
  });

  it('finds nested errors', () => {
    const errors = { 'blockedApps.3': 'bad', 'screenshot.activeFps': 'too fast' };
    expect(errorFor(errors, 'blockedApps')).toBe('bad');
    expect(errorFor(errors, 'screenshot.activeFps')).toBe('too fast');
    expect(errorFor(errors, 'screenshot.idleFps')).toBeNull();
  });

  it('translates issue codes', () => {
    expect(issueMessage({ code: 'too_small', path: [], message: '', minimum: 8, origin: 'string' }, t)).toBe('settings.validation.minLength:{"min":8}');
    expect(issueMessage({ code: 'too_big', path: [], message: '', maximum: 50, origin: 'array' }, t)).toBe('settings.validation.maxItems:{"max":50}');
    expect(issueMessage({ code: 'invalid_format', path: [], message: 'Invalid URL', format: 'url' }, t)).toBe('settings.validation.url');
    expect(issueMessage({ code: 'custom', path: [], message: 'whatever' }, t)).toBe('settings.validation.invalid');
  });

  it('parses API validation messages into field errors', () => {
    const parsed = parseServerValidation('connection.screenshot.activeFps: Too big; remote.port: Too small; body: Required', 'connection');
    expect(parsed.fields).toEqual({ 'screenshot.activeFps': 'Too big' });
    expect(parsed.general).toBe('remote.port: Too small; body: Required');
    expect(parseServerValidation('label: Too small', '').fields).toEqual({ label: 'Too small' });
    expect(parseServerValidation('Something else went wrong.', 'privacy')).toEqual({ fields: {}, general: 'Something else went wrong.' });
  });

  it('validates providers', () => {
    const lmstudio = DEFAULT_PROVIDERS.find((p) => p.id === 'lmstudio')!;
    expect(validateProvider({ ...lmstudio }, t)).toEqual({});
    expect(validateProvider({ ...lmstudio, baseUrl: null }, t)['baseUrl']).toBe('settings.validation.baseUrlRequired');
    expect(validateProvider({ ...lmstudio, baseUrl: 'ftp://x/v1' }, t)['baseUrl']).toBe('settings.validation.url');
    expect(validateProvider({ ...lmstudio, label: '' }, t)['label']).toBe('settings.validation.required');
    expect(validateProvider({ ...lmstudio, maxOutputTokens: 10 }, t)['maxOutputTokens']).toBe('settings.validation.min:{"min":256}');
  });
});

describe('remote access helpers', () => {
  it('classifies IPv4 addresses', () => {
    expect(classifyIPv4('100.101.102.103')).toBe('tailscale');
    expect(classifyIPv4('100.63.0.1')).toBe('public');
    expect(classifyIPv4('192.168.1.20')).toBe('private');
    expect(classifyIPv4('10.0.0.5')).toBe('private');
    expect(classifyIPv4('172.20.1.1')).toBe('private');
    expect(classifyIPv4('172.32.1.1')).toBe('public');
    expect(classifyIPv4('127.0.0.1')).toBe('loopback');
    expect(classifyIPv4('169.254.3.4')).toBe('link-local');
    expect(classifyIPv4('8.8.8.8')).toBe('public');
    expect(classifyIPv4('300.1.1.1')).toBe('invalid');
    expect(classifyIPv4('fe80::1')).toBe('invalid');
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(remoteUrlFor('100.64.0.1', 47824)).toBe('http://100.64.0.1:47824');
  });

  it('checks new passcodes', () => {
    expect(passcodeProblem('short', 'short')).toBe('settings.remote.passcode.tooShort');
    expect(passcodeProblem('long enough', 'different')).toBe('settings.remote.passcode.mismatch');
    expect(passcodeProblem('x'.repeat(129), 'x'.repeat(129))).toBe('settings.remote.passcode.tooLong');
    expect(passcodeProblem('correct horse', 'correct horse')).toBeNull();
  });
});

describe('provider helpers', () => {
  it('derives unique, valid provider ids', () => {
    expect(providerIdFromLabel('vLLM on Studio', [])).toBe('vllm-on-studio');
    expect(providerIdFromLabel('vLLM on Studio', ['vllm-on-studio'])).toBe('vllm-on-studio-2');
    expect(providerIdFromLabel('خادم محلي', [])).toBe('custom');
    expect(providerIdFromLabel('OpenAI', [])).toBe('openai-2');
    expect(providerIdFromLabel('Active', [])).toBe('active-2');
    expect(providerIdFromLabel('x'.repeat(80), [])).toHaveLength(32);
  });

  it('builds a custom OpenAI-compatible provider', () => {
    const local = makeCustomProvider({ label: ' vLLM ', baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen', vision: false }, []);
    expect(local).toMatchObject({ id: 'vllm', kind: 'openai-compatible', label: 'vLLM', cloud: false, hasApiKey: false, enabled: true, effort: null });
    expect(validateProvider(local, t)).toEqual({});
    const remote = makeCustomProvider({ label: 'Box', baseUrl: 'http://192.168.1.5:8000/v1', model: '', vision: true }, []);
    expect(remote.cloud).toBe(true);
  });
});

describe('permission editors', () => {
  it('adds blocked apps without duplicates', () => {
    expect(addBlockedApp(['Wallet'], '  Notes  ')).toEqual({ list: ['Wallet', 'Notes'], added: true });
    expect(addBlockedApp(['Wallet'], 'wallet')).toEqual({ list: ['Wallet'], added: false });
    expect(addBlockedApp(['Wallet'], '   ')).toEqual({ list: ['Wallet'], added: false });
  });

  it('parses keyword lists (including the Arabic comma)', () => {
    expect(parseKeywords('send, Post,\nsend ,، نشر, ')).toEqual(['send', 'Post', 'نشر']);
  });

  it('creates unique rule ids', () => {
    const rules = createDefaultSettings().permissions.sensitiveRules;
    expect(ruleIdFromLabel('Payment', rules)).toBe('payment-2');
    expect(ruleIdFromLabel('Bank transfers', rules)).toBe('bank-transfers');
    expect(ruleIdFromLabel('!!!', rules)).toBe('rule');
  });

  it('toggles list membership', () => {
    expect(toggleInList(['tap', 'swipe'], 'tap', false)).toEqual(['swipe']);
    expect(toggleInList(['swipe'], 'tap', true)).toEqual(['swipe', 'tap']);
    expect(toggleInList(['tap'], 'tap', true)).toEqual(['tap']);
  });
});
