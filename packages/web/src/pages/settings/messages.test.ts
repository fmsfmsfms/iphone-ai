// Every translation key used by the Activity and Settings pages (literal and
// dynamic) must exist in English and Arabic.

import { ALWAYS_DENIED_TOOLS, DEFAULT_AI_TOOLS } from '@iphone-ai/shared';
import { describe, expect, it } from 'vitest';

import '../activity/messages';
import './messages';
import { getCatalog } from '../../lib/i18n';
import { ACTIVITY_CATEGORIES, ACTIVITY_SEVERITIES } from '../activity/helpers';
import { SECTION_IDS } from './helpers';

const sources = import.meta.glob(['../activity/*.ts', '../activity/*.tsx', './*.ts', './*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx', '!../**/messages.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function literalKeys(): Set<string> {
  const keys = new Set<string>();
  // t('key') calls and string literals that look like keys handed to t() later.
  const patterns = [/\bt\(\s*'([^'$]+)'/g, /'((?:settings|activity)\.[A-Za-z0-9_.-]+)'/g];
  for (const source of Object.values(sources)) {
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) keys.add(match[1]!);
  }
  return keys;
}

const DYNAMIC: string[] = [
  ...SECTION_IDS.map((id) => `settings.nav.${id}`),
  ...['ok', 'warn', 'fail', 'unknown'].map((s) => `settings.connection.check.${s}`),
  ...['observe', 'assisted', 'supervised'].map((m) => `settings.permissions.mode.${m}`),
  ...[...DEFAULT_AI_TOOLS, ...ALWAYS_DENIED_TOOLS].map((tool) => `settings.permissions.tool.${tool}`),
  ...['low', 'medium', 'high', 'xhigh', 'max'].map((e) => `settings.providers.effort.${e}`),
  ...['activity', 'conversations', 'approvals', 'screenshots'].flatMap((k) => [`settings.privacy.delete.${k}.label`, `settings.privacy.delete.${k}.description`]),
  ...['tailscale', 'private', 'link-local', 'loopback', 'public', 'invalid'].map((k) => `settings.remote.address.kind.${k}`),
  ...['desktop', 'local-browser', 'remote'].map((k) => `settings.remote.sessions.kinds.${k}`),
  ...['tooShort', 'tooLong', 'mismatch'].map((k) => `settings.remote.passcode.${k}`),
  ...['min', 'max', 'minLength', 'maxLength', 'minItems', 'maxItems', 'integer', 'number', 'url', 'pattern', 'invalid', 'required', 'baseUrlRequired'].map(
    (k) => `settings.validation.${k}`,
  ),
  ...ACTIVITY_CATEGORIES.map((c) => `activity.category.${c}`),
  ...ACTIVITY_SEVERITIES.map((s) => `activity.severity.${s}`),
  ...['user', 'ai', 'workflow', 'system', 'remote-user'].map((a) => `actor.${a}`),
  ...['granted', 'denied', 'unknown'].map((s) => `permission.state.${s}`),
];

function exists(language: 'en' | 'ar', key: string): boolean {
  const catalog = getCatalog(language);
  return key in catalog || `${key}#other` in catalog;
}

describe('activity and settings messages', () => {
  it('scans the page sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(15);
  });

  it('define every key used, in English and Arabic', () => {
    const keys = [...literalKeys(), ...DYNAMIC];
    expect(keys.length).toBeGreaterThan(300);
    expect(keys.filter((k) => !exists('en', k))).toEqual([]);
    expect(keys.filter((k) => !exists('ar', k))).toEqual([]);
  });

  it('have an Arabic entry for every English entry', () => {
    const en = getCatalog('en');
    const ar = getCatalog('ar');
    const missing = Object.keys(en)
      .filter((k) => k.startsWith('settings.') || k.startsWith('activity.'))
      .filter((k) => {
        const base = k.split('#')[0]!;
        return !(k in ar) && !(`${base}#other` in ar) && !(base in ar);
      });
    expect(missing).toEqual([]);
  });

  it('keep placeholders identical across languages', () => {
    const en = getCatalog('en');
    const ar = getCatalog('ar');
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const mismatched = Object.keys(en)
      .filter((k) => (k.startsWith('settings.') || k.startsWith('activity.')) && !k.includes('#') && k in ar)
      .filter((k) => JSON.stringify(vars(en[k]!)) !== JSON.stringify(vars(ar[k]!)));
    expect(mismatched).toEqual([]);
  });
});
