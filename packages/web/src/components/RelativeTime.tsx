// "2s ago" / "in 5 min" that keeps itself up to date.

import { useEffect, useState } from 'react';

import { useI18n } from '../lib/i18n';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

const formatters = new Map<string, Intl.RelativeTimeFormat>();
function formatter(locale: string): Intl.RelativeTimeFormat {
  let f = formatters.get(locale);
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    formatters.set(locale, f);
  }
  return f;
}

/** Formats `at` relative to `now` (exported for tests and non-React callers). */
export function formatRelative(at: number, now: number, locale: string): string {
  const diffSec = Math.round((at - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 5) return formatter(locale).format(0, 'second');
  for (const [unit, seconds] of UNITS) {
    if (abs >= seconds || unit === 'second') {
      return formatter(locale).format(Math.round(diffSec / seconds), unit);
    }
  }
  return formatter(locale).format(diffSec, 'second');
}

/** Re-render cadence: every second for fresh times, slower for older ones. */
function tickFor(ageMs: number): number {
  if (ageMs < 60_000) return 1000;
  if (ageMs < 3_600_000) return 15_000;
  return 60_000;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface RelativeTimeProps {
  at: number | null | undefined;
  fallback?: string;
  className?: string;
}

export function RelativeTime({ at, fallback, className }: RelativeTimeProps) {
  const { locale, t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const id = setTimeout(() => setNow(Date.now()), tickFor(Date.now() - at));
    return () => clearTimeout(id);
  }, [at, now]);
  if (!at) return <span className={className}>{fallback ?? t('common.never')}</span>;
  const date = new Date(at);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString(locale)} className={className}>
      {formatRelative(at, now, locale)}
    </time>
  );
}
