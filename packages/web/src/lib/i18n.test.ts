import { afterEach, describe, expect, it } from 'vitest';

import '../pages/activity/messages';
import '../pages/assistant/messages';
import '../pages/automations/messages';
import '../pages/dashboard/messages';
import '../pages/live/messages';
import '../pages/settings/messages';
import { getCatalog, registerMessages, setLanguage, t, translate } from './i18n';

afterEach(() => setLanguage('en'));

describe('translate', () => {
  it('interpolates variables and formats numbers per language', () => {
    expect(translate('en', 'task.actions', { used: 3, max: 25 })).toBe('3 of 25 actions');
    expect(translate('ar', 'task.actions', { used: 3, max: 25 })).toBe('٣ من ٢٥ إجراء');
  });

  it('selects plural variants', () => {
    expect(translate('en', 'steps.hidden', { count: 1 })).toBe('1 earlier step hidden');
    expect(translate('en', 'steps.hidden', { count: 4 })).toBe('4 earlier steps hidden');
    expect(translate('ar', 'steps.hidden', { count: 4 })).toContain('٤');
  });

  it('falls back to English, then to the key', () => {
    registerMessages('test', { en: { onlyEnglish: 'English only' } });
    expect(translate('ar', 'test.onlyEnglish')).toBe('English only');
    expect(translate('en', 'test.missing.key')).toBe('test.missing.key');
  });

  it('registers namespaced page messages', () => {
    registerMessages('demo', { en: { hello: 'Hello {name}' }, ar: { hello: 'مرحبًا {name}' } });
    expect(translate('en', 'demo.hello', { name: 'Faisal' })).toBe('Hello Faisal');
    expect(translate('ar', 'demo.hello', { name: 'فيصل' })).toBe('مرحبًا فيصل');
  });
});

describe('setLanguage', () => {
  it('mirrors language and direction onto <html>', () => {
    setLanguage('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(t('nav.dashboard')).toBe('لوحة التحكم');
    setLanguage('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(t('nav.dashboard')).toBe('Dashboard');
  });
});

// Every key used literally in the source must exist in both dictionaries.
const sources = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx', '!../**/messages.ts', '!./i18n.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  const literal = /\bt\(\s*'([^']+)'/g;
  const known = /'((?:status|input|provider|composer|task|approval|step|steps|permission|viewer|mode|stop|connection)\.[A-Za-z.]+)'/g;
  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(literal)) keys.add(match[1]!);
    for (const match of source.matchAll(known)) keys.add(match[1]!);
  }
  return keys;
}

const DYNAMIC_FAMILIES: Record<string, string[]> = {
  'mode.{m}.name': ['observe', 'assisted', 'supervised'],
  'mode.{m}.description': ['observe', 'assisted', 'supervised'],
  'mode.{m}.confirm': ['observe', 'assisted', 'supervised'],
  'mode.{m}.point1': ['observe', 'assisted', 'supervised'],
  'mode.{m}.point2': ['observe', 'assisted', 'supervised'],
  'mode.{m}.point3': ['observe', 'assisted', 'supervised'],
  'mode.{m}.safety': ['observe', 'assisted', 'supervised'],
  'permission.state.{m}': ['granted', 'denied', 'unknown'],
  'orientation.{m}': ['portrait', 'landscape'],
  'actor.{m}': ['user', 'ai', 'workflow', 'system', 'remote-user'],
  'run.status.{m}': ['running', 'paused', 'awaiting_approval', 'succeeded', 'failed', 'stopped'],
  'connection.{m}': ['idle', 'connecting', 'open', 'reconnecting', 'closed'],
  'nav.{m}': ['dashboard', 'live', 'assistant', 'automations', 'activity', 'settings'],
  'task.error.{m}': ['pause', 'resume', 'cancel'],
};

function exists(language: 'en' | 'ar', key: string): boolean {
  const catalog = getCatalog(language);
  return key in catalog || `${key}#other` in catalog;
}

describe('message catalogs', () => {
  it('define every key used in the source, in English and Arabic', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    const keys = usedKeys();
    expect(keys.size).toBeGreaterThan(200);
    for (const [pattern, values] of Object.entries(DYNAMIC_FAMILIES)) {
      for (const value of values) keys.add(pattern.replace('{m}', value));
    }
    const ignored = new Set(['test.onlyEnglish', 'test.missing.key', 'demo.hello']);
    const missingEn = [...keys].filter((k) => !ignored.has(k) && !exists('en', k));
    const missingAr = [...keys].filter((k) => !ignored.has(k) && !exists('ar', k));
    expect(missingEn).toEqual([]);
    expect(missingAr).toEqual([]);
  });

  it('has an Arabic entry for every English entry', () => {
    const en = getCatalog('en');
    const ar = getCatalog('ar');
    const missing = Object.keys(en)
      .filter((k) => !k.startsWith('test.') && !k.startsWith('demo.'))
      .filter((k) => {
        const base = k.split('#')[0]!;
        return !(k in ar) && !(`${base}#other` in ar) && !(base in ar);
      });
    expect(missing).toEqual([]);
  });
});
