// Run side of the workflow page: start a run (with the reasons it can't),
// the live/latest run, the last successful run and the execution history
// (GET /api/workflows/:id/runs) with a detail drawer.

import { ArrowsRotateRight, CirclePlay, ClockArrowRotateLeft, Smartphone, Thunderbolt } from '@gravity-ui/icons';
import type { Workflow, WorkflowRun } from '@iphone-ai/shared';
import { Button, Drawer, Spinner, Table } from '@heroui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';
import { Panel } from '../../components/Panel';
import { RelativeTime, useNow } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { api, errorMessage } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { appStore, notifyError, shallowEqual, upsertRun, useActiveRun, useActiveTask, useAppStore, useCanControl } from '../../state/store';
import { ModeNotice } from './ModeNotice';
import { RunView } from './RunView';
import {
  formatClockDuration,
  isRunLive,
  lastSuccessfulRun,
  mergeRuns,
  RUN_STATUS_TONE,
  runBlockReason,
  runDurationMs,
  runProgress,
} from './workflow-utils';

export interface RunPanelProps {
  workflow: Workflow;
  dirty: boolean;
  /** Called when a run of this workflow finishes (the workflow's last-run fields changed). */
  onRunFinished?: () => void;
}

const HISTORY_LIMIT = 50;

export function RunPanel({ workflow, dirty, onRunFinished }: RunPanelProps) {
  const { t, locale } = useI18n();
  const canControl = useCanControl();
  const activeRun = useActiveRun();
  const activeTask = useActiveTask();
  const gate = useAppStore(
    (s) => ({
      connected: s.connection.socket === 'open',
      mode: s.settings?.permissions.controlMode ?? 'observe',
      stopLatched: s.stop.latched,
      mcpState: s.status?.server.state,
      mirroringState: s.status?.mirroring.state,
    }),
    shallowEqual,
  );
  const liveRuns = useAppStore((s) => Object.values(s.workflowRuns).filter((r) => r.workflowId === workflow.id), shallowEqual);
  const [fetched, setFetched] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  const [drawerRunId, setDrawerRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = (await api.workflows.runs(workflow.id)).slice(0, HISTORY_LIMIT);
      setFetched(list);
      // Correct store copies still shown as live although the server says they finished
      // (their last events were missed); this also fires the "run finished" refresh below.
      const stored = appStore.getState().workflowRuns;
      for (const run of list) {
        const copy = stored[run.id];
        if (copy && isRunLive(copy) && !isRunLive(run)) upsertRun(run);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workflow.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runs = useMemo(() => mergeRuns(fetched, liveRuns, workflow.id), [fetched, liveRuns, workflow.id]);

  // Refresh history (and the workflow's last-run fields) when one of its runs finishes.
  const liveIds = useRef(new Set<string>());
  useEffect(() => {
    let finished = false;
    for (const run of liveRuns) {
      if (isRunLive(run)) liveIds.current.add(run.id);
      else if (liveIds.current.delete(run.id)) finished = true;
    }
    if (finished) {
      void load();
      onRunFinished?.();
    }
  }, [liveRuns, load, onRunFinished]);

  const reason = runBlockReason({
    ...gate,
    canControl,
    dirty,
    stepCount: workflow.steps.length,
    workflowId: workflow.id,
    activeRun,
    activeTaskRunning: Boolean(activeTask),
  });
  const reasonText = reason ? t(reason.key, reason.vars) : null;
  // Retrying is gated like a new run, except that "already running" can't apply to a finished run.
  const current = runs.find((r) => r.id === focusRunId) ?? runs.find((r) => isRunLive(r)) ?? runs[0] ?? null;
  const lastSuccess = lastSuccessfulRun(runs);
  const drawerRun = runs.find((r) => r.id === drawerRunId) ?? null;

  const start = async () => {
    setStarting(true);
    try {
      const run = await api.workflows.run(workflow.id);
      upsertRun(run);
      setFocusRunId(run.id);
    } catch (err) {
      notifyError(t('automations.run.error.start'), err);
    } finally {
      setStarting(false);
    }
  };

  const onRetried = (run: WorkflowRun) => {
    setFocusRunId(run.id);
    setDrawerRunId(null);
  };

  return (
    <div className="flex flex-col gap-5">
      <Panel
        icon={<Thunderbolt />}
        tone={current && isRunLive(current) ? 'ai' : 'default'}
        title={t('automations.run.title')}
        description={t('automations.run.description')}
        actions={
          activeRun && activeRun.workflowId === workflow.id ? (
            <IconButton label={t('automations.run.openLive')} icon={<Smartphone />} onPress={() => navigate({ name: 'live' })} />
          ) : null
        }
      >
        <div className="flex flex-col gap-4">
          <ModeNotice />
          <div className="flex flex-col gap-1.5">
            <Button
              variant="primary"
              className={reason ? '' : 'ai-gradient-bg text-white'}
              isDisabled={Boolean(reason) || starting}
              isPending={starting}
              onPress={() => void start()}
              fullWidth
            >
              <CirclePlay className="size-4" />
              {t('automations.run.start')}
            </Button>
            {reasonText ? (
              // In Observe Only the notice above already explains what to do.
              reason?.key !== 'automations.run.reason.observe' ? <p className="text-xs leading-relaxed text-warning">{reasonText}</p> : null
            ) : (
              <p className="text-xs text-muted">{t('automations.run.startHint')}</p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-surface-secondary/60 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs text-muted">{t('automations.run.lastSuccess')}</p>
              <p className="text-[13px] font-medium text-foreground">
                {workflow.lastSuccessAt ? <RelativeTime at={workflow.lastSuccessAt} /> : t('automations.run.neverSucceeded')}
              </p>
            </div>
            {lastSuccess ? (
              <Button size="sm" variant="ghost" onPress={() => setDrawerRunId(lastSuccess.id)}>
                {t('automations.run.viewRun')}
              </Button>
            ) : null}
          </div>

          {current ? (
            <section aria-label={isRunLive(current) ? t('automations.run.liveTitle') : t('automations.run.latestTitle')} className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
                {isRunLive(current) ? t('automations.run.liveTitle') : t('automations.run.latestTitle')}
              </h3>
              <RunView run={current} workflow={workflow} retryBlockedReason={isRunLive(current) ? null : reasonText} onRetried={onRetried} />
            </section>
          ) : null}

          <p className="rounded-xl bg-default/40 px-3 py-2 text-[11px] leading-relaxed text-muted">{t('automations.unattended')}</p>
        </div>
      </Panel>

      <Panel
        icon={<ClockArrowRotateLeft />}
        title={t('automations.history.title')}
        description={t('automations.history.description')}
        actions={<IconButton label={t('automations.history.refresh')} icon={<ArrowsRotateRight />} onPress={() => void load()} isPending={loading} />}
      >
        <RunHistoryTable runs={runs} loading={loading} error={error} onRetry={() => void load()} onOpen={setDrawerRunId} />
      </Panel>

      <Drawer.Backdrop isOpen={drawerRun !== null} onOpenChange={(open) => !open && setDrawerRunId(null)} variant="blur">
        {/* "right" uses justify-end, which is the logical end edge (left in RTL). */}
        <Drawer.Content placement="right">
          <Drawer.Dialog className="flex h-full w-[min(560px,100vw)] max-w-none flex-col border-s border-hairline bg-overlay">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading className="text-base font-semibold">{t('automations.history.drawerTitle')}</Drawer.Heading>
              {drawerRun ? (
                <p className="mt-0.5 text-xs text-muted">
                  {new Date(drawerRun.startedAt).toLocaleString(locale)}
                </p>
              ) : null}
            </Drawer.Header>
            <Drawer.Body className="app-scroll min-h-0 flex-1">
              {drawerRun ? (
                <RunView run={drawerRun} workflow={workflow} retryBlockedReason={isRunLive(drawerRun) ? null : reasonText} onRetried={onRetried} />
              ) : null}
            </Drawer.Body>
            <Drawer.Footer className="flex justify-end">
              <Button variant="secondary" slot="close">
                {t('common.close')}
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </div>
  );
}

interface RunHistoryTableProps {
  runs: WorkflowRun[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (runId: string) => void;
}

function RunHistoryTable({ runs, loading, error, onRetry, onOpen }: RunHistoryTableProps) {
  const { t, formatNumber } = useI18n();
  const now = useNow(runs.some((r) => isRunLive(r)) ? 1000 : 60_000);

  if (runs.length === 0) {
    if (loading) {
      return (
        <div className="flex items-center gap-2 py-4 text-xs text-muted" role="status">
          <Spinner size="sm" />
          {t('automations.history.loading')}
        </div>
      );
    }
    if (error) {
      return (
        <EmptyState
          size="sm"
          tone="danger"
          title={t('automations.history.error')}
          description={error}
          actions={
            <Button size="sm" variant="secondary" onPress={onRetry}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      );
    }
    return <EmptyState size="sm" icon={<ClockArrowRotateLeft />} title={t('automations.history.empty.title')} description={t('automations.history.empty.body')} />;
  }

  return (
    <Table variant="secondary" className="min-w-0">
      <Table.ScrollContainer className="app-scroll max-h-96">
        <Table.Content aria-label={t('automations.history.title')} className="min-w-[420px]" onRowAction={(key) => onOpen(String(key))}>
          <Table.Header>
            <Table.Column isRowHeader>{t('automations.history.status')}</Table.Column>
            <Table.Column>{t('automations.history.started')}</Table.Column>
            <Table.Column>{t('automations.history.duration')}</Table.Column>
            <Table.Column>{t('automations.history.steps')}</Table.Column>
          </Table.Header>
          <Table.Body items={runs}>
            {(run) => {
              const progress = runProgress(run);
              return (
                <Table.Row id={run.id} className="cursor-pointer">
                  <Table.Cell>
                    <StatusChip size="sm" tone={RUN_STATUS_TONE[run.status]} pulse={run.status === 'running'} label={t(`run.status.${run.status}`)} />
                  </Table.Cell>
                  <Table.Cell className="text-xs text-muted">
                    <RelativeTime at={run.startedAt} />
                  </Table.Cell>
                  <Table.Cell className="text-xs text-muted tabular-nums">{formatClockDuration(runDurationMs(run, now))}</Table.Cell>
                  <Table.Cell className="text-xs text-muted tabular-nums">
                    {t('automations.history.stepsValue', { done: formatNumber(progress.succeeded), total: formatNumber(progress.total) })}
                  </Table.Cell>
                </Table.Row>
              );
            }}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
