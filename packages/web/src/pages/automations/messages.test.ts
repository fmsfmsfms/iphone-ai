// Every string the Automations page uses exists in English and Arabic.

import { describe, expect, it } from 'vitest';

import './messages';
import { getCatalog } from '../../lib/i18n';
import { STEP_GROUPS, STEP_TYPES } from './step-meta';

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
  const keys = new Set<string>();
  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(/'(automations\.[A-Za-z0-9_.-]+)'/g)) keys.add(match[1]!);
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) keys.add(match[1]!);
  }
  const families: Record<string, readonly string[]> = {
    'automations.direction.{m}': ['up', 'down', 'left', 'right', 'auto'],
    'automations.directionWord.{m}': ['up', 'down', 'left', 'right'],
    'automations.distance.{m}': ['short', 'medium', 'long'],
    'automations.export.copied.{m}': ['path', 'markdown'],
    'automations.group.{m}': STEP_GROUPS.map((g) => g.group),
    'automations.recorder.point{m}': ['1', '2', '3'],
    'automations.run.error.{m}': ['start', 'pause', 'resume', 'stop', 'retry', 'retryFailed'],
    'automations.source.{m}': ['manual', 'ai-suggested', 'recorded', 'imported'],
    'automations.stepStatus.{m}': ['pending', 'running', 'succeeded', 'failed', 'skipped'],
    'automations.stepType.{m}.name': STEP_TYPES,
    'automations.stepType.{m}.description': STEP_TYPES,
    'run.status.{m}': ['running', 'paused', 'awaiting_approval', 'succeeded', 'failed', 'stopped'],
  };
  for (const [pattern, values] of Object.entries(families)) for (const v of values) keys.add(pattern.replace('{m}', v));
  return keys;
}

describe('automations messages', () => {
  it('define every key used by the page in English and Arabic', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const keys = [...usedKeys()];
    expect(keys.length).toBeGreaterThan(150);
    expect(keys.filter((k) => !exists('en', k))).toEqual([]);
    expect(keys.filter((k) => !exists('ar', k))).toEqual([]);
  });

  it('has an Arabic entry for every English entry', () => {
    const en = getCatalog('en');
    const ar = getCatalog('ar');
    const missing = Object.keys(en)
      .filter((k) => k.startsWith('automations.'))
      .filter((k) => {
        const base = k.split('#')[0]!;
        return !(k in ar) && !(`${base}#other` in ar) && !(base in ar);
      });
    expect(missing).toEqual([]);
  });
});
