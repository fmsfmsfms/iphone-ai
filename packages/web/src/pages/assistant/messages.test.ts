// Every string the AI Assistant page uses exists in English and Arabic.

import { describe, expect, it } from 'vitest';

import './messages';
import { FAILURE_KINDS } from '../../components/chat/task-ui';
import { getCatalog } from '../../lib/i18n';
import { EXAMPLE_PROMPT_KEYS } from './assistant-utils';

const sources = import.meta.glob(['./*.ts', './*.tsx', '!./*.test.ts', '!./*.test.tsx', '!./messages.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function exists(language: 'en' | 'ar', key: string): boolean {
  const catalog = getCatalog(language);
  return key in catalog || `${key}#other` in catalog;
}

function usedKeys(): Set<string> {
  const keys = new Set<string>(EXAMPLE_PROMPT_KEYS);
  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(/'(assistant\.[A-Za-z0-9_.-]+)'/g)) keys.add(match[1]!);
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) keys.add(match[1]!);
  }
  // Failure explanations shown in the conversation (shared with Live Control).
  for (const kind of FAILURE_KINDS) {
    keys.add(`task.failure.${kind}.title`);
    keys.add(`task.failure.${kind}.body`);
  }
  for (const group of ['today', 'yesterday', 'week', 'older']) keys.add(`assistant.list.group.${group}`);
  for (const mode of ['observe', 'assisted', 'supervised']) {
    keys.add(`mode.${mode}.name`);
    keys.add(`mode.${mode}.description`);
  }
  return keys;
}

describe('assistant messages', () => {
  it('define every key used by the page in English and Arabic', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(4);
    const keys = [...usedKeys()];
    expect(keys.length).toBeGreaterThan(80);
    expect(keys.filter((k) => !exists('en', k))).toEqual([]);
    expect(keys.filter((k) => !exists('ar', k))).toEqual([]);
  });

  it('has an Arabic entry for every English entry', () => {
    const en = getCatalog('en');
    const ar = getCatalog('ar');
    const missing = Object.keys(en)
      .filter((k) => k.startsWith('assistant.'))
      .filter((k) => {
        const base = k.split('#')[0]!;
        return !(k in ar) && !(`${base}#other` in ar) && !(base in ar);
      });
    expect(missing).toEqual([]);
  });
});
