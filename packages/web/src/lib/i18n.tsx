// Tiny i18n layer: English + Arabic dictionaries, `{name}` interpolation,
// plural variants (`key#one`, `key#other`, … selected with Intl.PluralRules),
// page-level registration and RTL handling.
//
//   const { t } = useI18n();
//   t('shell.stop.button')
//   t('chat.pending', { count: 3 })           // looks up chat.pending#few / #other …
//   registerMessages('settings', { en: { title: 'Settings' }, ar: { title: 'الإعدادات' } });
//   t('settings.title')

import { I18nProvider } from '@heroui/react';
import { useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { arMessages, enMessages } from './messages';

export type Language = 'en' | 'ar';
export type Direction = 'ltr' | 'rtl';
export type MessageVars = Record<string, string | number | null | undefined>;
export type Messages = Record<string, string>;

const LOCALES: Record<Language, string> = { en: 'en-US', ar: 'ar-SA' };

const catalogs: Record<Language, Messages> = {
  en: { ...enMessages },
  ar: { ...arMessages },
};

let currentLanguage: Language = 'en';
let revision = 0;
const listeners = new Set<() => void>();

function emit(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/**
 * Adds a page's own strings. Keys are stored as `<namespace>.<key>`.
 * Arabic entries may be partial; missing ones fall back to English.
 */
export function registerMessages(namespace: string, messages: { en: Messages; ar?: Partial<Messages> }): void {
  const prefix = namespace ? `${namespace}.` : '';
  for (const [key, value] of Object.entries(messages.en)) catalogs.en[`${prefix}${key}`] = value;
  for (const [key, value] of Object.entries(messages.ar ?? {})) {
    if (typeof value === 'string') catalogs.ar[`${prefix}${key}`] = value;
  }
  emit();
}

export function hasMessage(key: string, language: Language = 'en'): boolean {
  return key in catalogs[language];
}

/** Snapshot of a dictionary (for tests and tooling). */
export function getCatalog(language: Language): Readonly<Messages> {
  return catalogs[language];
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();
function pluralCategory(count: number, language: Language): string {
  const locale = LOCALES[language];
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules.select(count);
}

function lookup(key: string, language: Language): string | undefined {
  return catalogs[language][key] ?? catalogs.en[key];
}

function interpolate(template: string, vars: MessageVars | undefined, language: Language): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) return match;
    if (typeof value === 'number') return formatNumber(value, language);
    return value;
  });
}

/** Translates `key` in the current language (falls back to English, then to the key). */
export function t(key: string, vars?: MessageVars): string {
  return translate(currentLanguage, key, vars);
}

export function translate(language: Language, key: string, vars?: MessageVars): string {
  let template: string | undefined;
  const count = vars?.['count'];
  if (typeof count === 'number') {
    const category = pluralCategory(count, language);
    template =
      catalogs[language][`${key}#${category}`] ??
      catalogs[language][`${key}#other`] ??
      catalogs.en[`${key}#${pluralCategory(count, 'en')}`] ??
      catalogs.en[`${key}#other`];
  }
  template ??= lookup(key, language);
  if (template === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] missing message "${key}"`);
    return key;
  }
  return interpolate(template, vars, language);
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function directionOf(language: Language): Direction {
  return language === 'ar' ? 'rtl' : 'ltr';
}

export function localeOf(language: Language): string {
  return LOCALES[language];
}

/** Switches the UI language and mirrors it onto <html lang dir>. */
export function setLanguage(language: Language): void {
  const next: Language = language === 'ar' ? 'ar' : 'en';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
    document.documentElement.dir = directionOf(next);
  }
  if (next === currentLanguage) return;
  currentLanguage = next;
  emit();
}

const numberFormatCache = new Map<string, Intl.NumberFormat>();
export function formatNumber(value: number, language: Language = currentLanguage, options?: Intl.NumberFormatOptions): string {
  const key = `${language}:${JSON.stringify(options ?? {})}`;
  let format = numberFormatCache.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALES[language], options);
    numberFormatCache.set(key, format);
  }
  return format.format(value);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): number {
  return revision;
}

export interface I18nApi {
  t: (key: string, vars?: MessageVars) => string;
  language: Language;
  dir: Direction;
  locale: string;
  isRTL: boolean;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

/** Subscribes the component to language and dictionary changes. */
export function useI18n(): I18nApi {
  const rev = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => {
    void rev;
    const language = currentLanguage;
    return {
      t: (key: string, vars?: MessageVars) => translate(language, key, vars),
      language,
      dir: directionOf(language),
      locale: LOCALES[language],
      isRTL: language === 'ar',
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(value, language, options),
    };
  }, [rev]);
}

/** Applies the language (from settings) and provides React Aria's locale context. */
export function I18nRoot({ language, children }: { language: Language; children: ReactNode }) {
  // Layout effect: the switch (and the re-render it triggers) happens before paint.
  useLayoutEffect(() => {
    setLanguage(language);
  }, [language]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return <I18nProvider locale={LOCALES[currentLanguage]}>{children}</I18nProvider>;
}
