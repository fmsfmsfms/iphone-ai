// The latest audit-log entries (GET /api/activity?limit=8), kept current
// with live `activity` events.

import { CircleCheckFill, CircleInfo, CircleXmarkFill, ClockArrowRotateLeft, TriangleExclamationFill } from '@gravity-ui/icons';
import type { ActivityEvent } from '@iphone-ai/shared';
import { Button, Skeleton } from '@heroui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { EmptyState } from '../../components/EmptyState';
import { Panel } from '../../components/Panel';
import { RelativeTime } from '../../components/RelativeTime';
import { api, errorMessage } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { useLiveActivity } from '../../state/store';

const LIMIT = 8;

function EventIcon({ event }: { event: ActivityEvent }) {
  if (event.severity === 'error' || event.success === false) return <CircleXmarkFill className="size-4 text-danger" />;
  if (event.severity === 'warning') return <TriangleExclamationFill className="size-4 text-warning" />;
  if (event.success === true) return <CircleCheckFill className="size-4 text-success" />;
  return <CircleInfo className="size-4 text-muted" />;
}

export function ActivityCard() {
  const { t } = useI18n();
  const live = useLiveActivity();
  const [loaded, setLoaded] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setLoaded(await api.activity.list({ limit: LIMIT }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const events = useMemo(() => {
    const byId = new Map<string, ActivityEvent>();
    for (const e of [...live, ...(loaded ?? [])]) if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, LIMIT);
  }, [live, loaded]);

  return (
    <Panel
      icon={<ClockArrowRotateLeft />}
      title={t('dashboard.activity.title')}
      description={t('dashboard.activity.description')}
      actions={
        <Button size="sm" variant="ghost" onPress={() => navigate({ name: 'activity' })}>
          {t('dashboard.activity.viewAll')}
        </Button>
      }
    >
      {loaded === null && !error && events.length === 0 ? (
        <div className="flex flex-col gap-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 rounded-lg" />
          ))}
        </div>
      ) : error && events.length === 0 ? (
        <EmptyState
          size="sm"
          tone="danger"
          icon={<TriangleExclamationFill />}
          title={t('dashboard.activity.error')}
          description={error}
          actions={
            <Button size="sm" variant="secondary" onPress={() => void load()}>
              {t('dashboard.activity.retry')}
            </Button>
          }
        />
      ) : events.length === 0 ? (
        <EmptyState size="sm" icon={<ClockArrowRotateLeft />} title={t('dashboard.activity.empty.title')} description={t('dashboard.activity.empty.body')} />
      ) : (
        <ul className="flex flex-col divide-y divide-hairline">
          {events.map((event) => (
            <li key={event.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="mt-0.5 shrink-0">
                <EventIcon event={event} />
              </span>
              <div className="min-w-0 flex-1">
                <p dir="auto" className="text-[13px] leading-5 break-words text-foreground">
                  {event.summary}
                </p>
                <p className="text-[11px] text-muted">
                  {t(`actor.${event.actor}`)}
                  {event.tool ? ` · ${event.tool}` : ''}
                </p>
              </div>
              <RelativeTime at={event.at} className="shrink-0 text-[11px] text-muted" />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
