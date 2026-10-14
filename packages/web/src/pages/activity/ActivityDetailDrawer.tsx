// Side drawer with every field of one activity event, its redacted detail as
// readable key/value rows (raw JSON on request) and links to the related AI
// task or automation run.

import { ArrowUpRightFromSquare, Copy, Funnel, Sparkles, Thunderbolt } from '@gravity-ui/icons';
import type { ActivityEvent } from '@iphone-ai/shared';
import { Button, Drawer, Spinner } from '@heroui/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { KeyValueList, type KeyValueItem } from '../../components/KeyValue';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { formatDuration, TASK_STATUS_KEY, TASK_STATUS_TONE } from '../../components/chat/task-ui';
import { api, isApiError } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { loadTask, notify, notifyError, useTask } from '../../state/store';
import { detailEntries, eventOutcome, rawDetail, type DetailEntry } from './helpers';
import { CategoryTile, OutcomeIcon } from './meta';

export interface ActivityDetailDrawerProps {
  event: ActivityEvent | null;
  onClose: () => void;
  onFilterTask: (taskId: string) => void;
}

function DetailValue({ entry }: { entry: DetailEntry }) {
  const { t } = useI18n();
  switch (entry.kind) {
    case 'null':
      return <span className="text-muted">—</span>;
    case 'boolean':
      return <span>{entry.value === 'true' ? t('activity.detail.yes') : t('activity.detail.no')}</span>;
    case 'number':
      return <span className="tabular-nums" dir="ltr">{entry.value}</span>;
    case 'list':
      if (!entry.items || entry.items.length === 0) return <span className="text-muted">{t('activity.detail.emptyValue')}</span>;
      return (
        <span className="flex flex-wrap gap-1">
          {entry.items.map((item, i) => (
            <span key={i} dir="auto" className="rounded-md bg-default px-1.5 py-px text-[12px]">
              {item || t('activity.detail.emptyValue')}
            </span>
          ))}
        </span>
      );
    case 'json':
      return (
        <code dir="ltr" className="font-mono text-[11.5px] break-all text-foreground/90">
          {entry.value}
        </code>
      );
    default:
      return entry.value ? (
        <span dir="auto" className="break-words whitespace-pre-wrap">
          {entry.value}
        </span>
      ) : (
        <span className="text-muted">{t('activity.detail.emptyValue')}</span>
      );
  }
}

function TaskLink({ taskId, onFilterTask }: { taskId: string; onFilterTask: (taskId: string) => void }) {
  const { t } = useI18n();
  const task = useTask(taskId);
  const [state, setState] = useState<'idle' | 'loading' | 'missing'>('idle');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    loadTask(taskId)
      .then(() => !cancelled && setState('idle'))
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(isApiError(err) && err.status === 404 ? 'missing' : 'idle');
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return (
    <div className="ai-soft-bg flex flex-col gap-2.5 rounded-xl border border-hairline p-3">
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="ai-gradient-bg mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-white [&>svg]:size-3.5">
          <Sparkles />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('activity.detail.task')}</p>
          {task ? (
            <>
              <p dir="auto" className="mt-0.5 text-[13px] leading-5 break-words text-foreground">
                {task.instruction}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusChip size="sm" tone={TASK_STATUS_TONE[task.status]} label={t(TASK_STATUS_KEY[task.status])} />
                <span className="text-[11px] text-muted">{task.providerLabel}</span>
              </div>
            </>
          ) : state === 'loading' ? (
            <p className="mt-1 flex items-center gap-2 text-xs text-muted">
              <Spinner size="sm" />
              {t('activity.detail.taskLoading')}
            </p>
          ) : state === 'missing' ? (
            <p className="mt-0.5 text-xs text-muted">{t('activity.detail.taskUnavailable')}</p>
          ) : null}
          <code dir="ltr" className="mt-1 block font-mono text-[11px] break-all text-muted">
            {taskId}
          </code>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {task ? (
          <Button size="sm" variant="secondary" onPress={() => navigate({ name: 'assistant', conversationId: task.conversationId })}>
            <ArrowUpRightFromSquare className="size-3.5" />
            {t('activity.detail.openTask')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onPress={() => onFilterTask(taskId)}>
          <Funnel className="size-3.5" />
          {t('activity.detail.filterTask')}
        </Button>
      </div>
    </div>
  );
}

function RunLink({ runId }: { runId: string }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const open = async () => {
    setPending(true);
    try {
      const run = await api.workflowRuns.get(runId);
      navigate({ name: 'automations', workflowId: run.workflowId });
    } catch (err) {
      notifyError(t('activity.detail.openRunFailed'), err);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-hairline bg-surface-secondary p-3">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ai-purple/15 text-ai-purple [&>svg]:size-3.5">
        <Thunderbolt />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('activity.detail.run')}</p>
        <code dir="ltr" className="block font-mono text-[11px] break-all text-foreground/80">
          {runId}
        </code>
      </div>
      <Button size="sm" variant="secondary" isPending={pending} onPress={() => void open()}>
        <ArrowUpRightFromSquare className="size-3.5" />
        {t('activity.detail.openRun')}
      </Button>
    </div>
  );
}

function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h3 className="flex-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{children}</h3>
      {actions}
    </div>
  );
}

export function ActivityDetailDrawer({ event, onClose, onFilterTask }: ActivityDetailDrawerProps) {
  const { t, locale, isRTL } = useI18n();
  const [raw, setRaw] = useState(false);
  // Keep the last event while the drawer animates closed.
  const [shown, setShown] = useState<ActivityEvent | null>(event);
  useEffect(() => {
    if (event) setShown(event);
  }, [event]);
  useEffect(() => setRaw(false), [event?.id]);

  const entries = useMemo(() => detailEntries(shown?.detail), [shown]);

  const copyRaw = async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(rawDetail(shown.detail) || '{}');
      notify('success', t('activity.detail.copied'));
    } catch (err) {
      notifyError(t('activity.detail.copyFailed'), err);
    }
  };

  const items: KeyValueItem[] = [];
  if (shown) {
    const outcome = eventOutcome(shown);
    items.push(
      {
        key: 'when',
        label: t('activity.detail.when'),
        value: (
          <span className="flex flex-col">
            <span>{new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'medium' }).format(shown.at)}</span>
            <RelativeTime at={shown.at} className="text-xs text-muted" />
          </span>
        ),
      },
      { key: 'category', label: t('activity.detail.category'), value: t(`activity.category.${shown.category}`) },
      { key: 'actor', label: t('activity.detail.actor'), value: t(`actor.${shown.actor}`) },
      {
        key: 'severity',
        label: t('activity.detail.severity'),
        value: (
          <StatusChip
            size="sm"
            tone={shown.severity === 'error' ? 'danger' : shown.severity === 'warning' ? 'warning' : 'default'}
            label={t(`activity.severity.${shown.severity}`)}
          />
        ),
      },
      { key: 'type', label: t('activity.detail.type'), value: <bdi dir="ltr">{shown.type}</bdi>, mono: true },
    );
    if (shown.tool) items.push({ key: 'tool', label: t('activity.detail.tool'), value: <bdi dir="ltr">{shown.tool}</bdi>, mono: true });
    if (shown.success !== null) {
      items.push({
        key: 'result',
        label: t('activity.detail.result'),
        value: (
          <span className={['inline-flex items-center gap-1.5', outcome === 'failure' ? 'text-danger' : 'text-success'].join(' ')}>
            <OutcomeIcon event={shown} />
            {shown.success ? t('activity.event.succeeded') : t('activity.event.failed')}
          </span>
        ),
      });
    }
    if (shown.durationMs !== null) items.push({ key: 'duration', label: t('activity.detail.duration'), value: formatDuration(shown.durationMs, locale) });
    items.push(
      { key: 'session', label: t('activity.detail.session'), value: <bdi dir="ltr">{shown.sessionId}</bdi>, mono: true },
      { key: 'id', label: t('activity.detail.id'), value: <bdi dir="ltr">{shown.id}</bdi>, mono: true },
    );
  }

  return (
    <Drawer.Backdrop isOpen={event !== null} onOpenChange={(open) => !open && onClose()} variant="blur">
      {/* Logical end edge: right in English, left in Arabic (justify-end follows the direction). */}
      <Drawer.Content placement={isRTL ? 'left' : 'right'} className="justify-end">
        <Drawer.Dialog
          className="flex h-full w-full max-w-[100vw] flex-col border-s border-hairline bg-overlay p-0 sm:w-[30rem]"
          aria-label={t('activity.detail.title')}
        >
          <Drawer.CloseTrigger className="absolute top-4 end-4" />
          {shown ? (
            <>
              <Drawer.Header className="flex flex-row items-start gap-3 border-b border-hairline px-5 pt-5 pb-4 pe-12">
                <CategoryTile category={shown.category} />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('activity.detail.title')}</p>
                  <Drawer.Heading dir="auto" className="mt-0.5 text-[15px] leading-6 font-semibold break-words text-foreground">
                    {shown.summary}
                  </Drawer.Heading>
                </div>
              </Drawer.Header>
              <Drawer.Body className="app-scroll flex min-h-0 flex-1 flex-col gap-5 px-5 py-4">
                <KeyValueList items={items} dense />

                {shown.taskId ? <TaskLink taskId={shown.taskId} onFilterTask={onFilterTask} /> : null}
                {shown.workflowRunId ? <RunLink runId={shown.workflowRunId} /> : null}

                <section className="flex flex-col gap-2.5">
                  <SectionTitle
                    actions={
                      shown.detail ? (
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" onPress={() => setRaw((r) => !r)}>
                            {raw ? t('activity.detail.showReadable') : t('activity.detail.showRaw')}
                          </Button>
                          <Button size="sm" variant="ghost" isIconOnly aria-label={t('activity.detail.copy')} onPress={() => void copyRaw()}>
                            <Copy className="size-3.5" />
                          </Button>
                        </div>
                      ) : null
                    }
                  >
                    {t('activity.detail.details')}
                  </SectionTitle>
                  {!shown.detail || entries.length === 0 ? (
                    <p className="text-[13px] text-muted">{t('activity.detail.noDetails')}</p>
                  ) : raw ? (
                    <pre dir="ltr" className="app-scroll max-h-96 rounded-xl border border-hairline bg-surface-secondary p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground/90">
                      {rawDetail(shown.detail)}
                    </pre>
                  ) : (
                    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2 rounded-xl border border-hairline bg-surface-secondary p-3">
                      {entries.map((entry) => (
                        <div key={entry.path} className="contents">
                          <dt className="text-[12px] leading-5 text-muted">{entry.label}</dt>
                          <dd className="min-w-0 text-[13px] leading-5 text-foreground">
                            <DetailValue entry={entry} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <p className="text-[11px] leading-relaxed text-muted">{t('activity.detail.redacted')}</p>
                </section>
              </Drawer.Body>
            </>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
