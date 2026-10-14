// Readable timeline grouped by day (Today / Yesterday / date). Each row opens
// the detail drawer.

import { ChevronRight } from '@gravity-ui/icons';
import type { ActivityEvent } from '@iphone-ai/shared';
import { useMemo } from 'react';

import { RelativeTime } from '../../components/RelativeTime';
import { formatDuration } from '../../components/chat/task-ui';
import { useI18n } from '../../lib/i18n';
import { eventOutcome, groupByDay, type DayGroup } from './helpers';
import { CategoryTile, OutcomeIcon } from './meta';

export interface ActivityTimelineProps {
  events: ActivityEvent[];
  now: number;
  selectedId: string | null;
  onSelect: (event: ActivityEvent) => void;
}

function useDayLabel() {
  const { t, locale } = useI18n();
  return useMemo(() => {
    const thisYear = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' });
    const otherYear = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    return (group: DayGroup, now: number) => {
      if (group.kind === 'today') return t('activity.day.today');
      if (group.kind === 'yesterday') return t('activity.day.yesterday');
      const date = new Date(group.dayStart);
      return (date.getFullYear() === new Date(now).getFullYear() ? thisYear : otherYear).format(date);
    };
  }, [t, locale]);
}

function EventRow({ event, selected, onSelect, today }: { event: ActivityEvent; selected: boolean; onSelect: () => void; today: boolean }) {
  const { t, locale } = useI18n();
  const outcome = eventOutcome(event);
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(event.at), [event.at, locale]);
  const meta: string[] = [t(`actor.${event.actor}`)];
  if (event.durationMs !== null) meta.push(formatDuration(event.durationMs, locale));
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-label={`${event.summary} — ${t('activity.event.open')}`}
        aria-haspopup="dialog"
        aria-current={selected ? 'true' : undefined}
        className={[
          'app-transition group flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-start outline-none',
          'hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus',
          selected ? 'bg-active' : '',
        ].join(' ')}
      >
        <CategoryTile category={event.category} />
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-1.5">
            <OutcomeIcon event={event} className="mt-[3px]" />
            <span dir="auto" className="min-w-0 text-[13px] leading-5 font-medium break-words text-foreground">
              {event.summary}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted">
            <span>{meta.join(' · ')}</span>
            {event.tool ? (
              <code dir="ltr" className="rounded-md bg-default px-1.5 py-px font-mono text-[10.5px] text-foreground/80">
                {event.tool}
              </code>
            ) : null}
            {outcome === 'success' && event.success === true ? <span className="text-success">{t('activity.event.succeeded')}</span> : null}
            {outcome === 'failure' && event.success === false ? <span className="text-danger">{t('activity.event.failed')}</span> : null}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-end">
          <span className="text-[11px] font-medium text-foreground/80 tabular-nums">{time}</span>
          {/* Older days are named by the group header; a relative time there ("2 days ago") would contradict it. */}
          {today ? <RelativeTime at={event.at} className="text-[11px] text-muted" /> : null}
        </span>
        <ChevronRight aria-hidden className="mt-2 size-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 rtl:-scale-x-100" />
      </button>
    </li>
  );
}

export function ActivityTimeline({ events, now, selectedId, onSelect }: ActivityTimelineProps) {
  const { t } = useI18n();
  const dayLabel = useDayLabel();
  const groups = useMemo(() => groupByDay(events, now), [events, now]);
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`day-${group.key}`}>
          <header className="app-glass sticky top-0 z-10 -mx-1 mb-1 flex items-baseline gap-2 rounded-lg px-4 py-1.5">
            <h2 id={`day-${group.key}`} className="text-[13px] font-semibold text-foreground">
              {dayLabel(group, now)}
            </h2>
            <span className="text-[11px] text-muted">{t('activity.count', { count: group.events.length })}</span>
          </header>
          <ul className="flex flex-col gap-0.5">
            {group.events.map((event) => (
              <EventRow key={event.id} event={event} today={group.kind === 'today'} selected={event.id === selectedId} onSelect={() => onSelect(event)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
