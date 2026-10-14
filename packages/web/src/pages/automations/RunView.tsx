// One workflow run: status, progress, controls (pause / resume / stop /
// retry) and per-step results with messages, read_screen outputs,
// screenshots and errors. Pending approvals for the run appear at the step
// that is waiting.

import {
  ArrowRotateLeft,
  CircleCheckFill,
  CircleDashed,
  CircleMinus,
  CirclePause,
  CirclePlay,
  CircleStop,
  CircleXmarkFill,
  TriangleExclamation,
} from '@gravity-ui/icons';
import type { StepRunResult, StepRunStatus, Workflow, WorkflowRun, WorkflowStep } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useState, type ReactNode } from 'react';

import { ApprovalCard, formatDuration } from '../../components/chat';
import { RelativeTime, useNow } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { notifyError, shallowEqual, upsertRun, useAppStore, useCanControl } from '../../state/store';
import { Notice } from './fields';
import { ScreenshotModal, ScreenshotThumb, type ScreenshotRef } from './ScreenshotModal';
import { StepIcon } from './StepIcon';
import { summarizeStep } from './step-meta';
import { formatClockDuration, isRunLive, retryOptions, RUN_STATUS_TONE, runDurationMs, runProgress, stepDurationMs } from './workflow-utils';

const STEP_STATUS_ICON: Record<StepRunStatus, ReactNode> = {
  pending: <CircleDashed className="size-4 text-muted" />,
  running: <Spinner size="sm" color="accent" />,
  succeeded: <CircleCheckFill className="size-4 text-success" />,
  failed: <CircleXmarkFill className="size-4 text-danger" />,
  skipped: <CircleMinus className="size-4 text-muted" />,
};

export interface RunViewProps {
  run: WorkflowRun;
  workflow: Workflow;
  /** Why a retry can't start right now (translated), or null. */
  retryBlockedReason?: string | null;
  onRetried?: (run: WorkflowRun) => void;
  className?: string;
}

type PendingAction = 'pause' | 'resume' | 'stop' | 'retry' | 'retryFailed' | null;

export function RunView({ run, workflow, retryBlockedReason, onRetried, className }: RunViewProps) {
  const { t, locale } = useI18n();
  const canControl = useCanControl();
  const live = isRunLive(run);
  const now = useNow(live ? 1000 : 60_000);
  const [pending, setPending] = useState<PendingAction>(null);
  const [shot, setShot] = useState<ScreenshotRef | null>(null);
  const approvals = useAppStore((s) => s.approvals.filter((a) => a.workflowRunId === run.id), shallowEqual);
  const progress = runProgress(run);
  const retry = retryOptions(run);
  const stepsById = new Map(workflow.steps.map((s) => [s.id, s] as const));
  // Live runs show how far they got; finished runs show how much succeeded.
  const ratio = progress.total > 0 ? (live || run.status === 'succeeded' ? progress.done : progress.succeeded) / progress.total : 0;
  const currentNumber = Math.min(run.currentStepIndex + 1, Math.max(progress.total, 1));

  const act = async (action: Exclude<PendingAction, null>) => {
    setPending(action);
    try {
      let next: WorkflowRun;
      if (action === 'pause') next = await api.workflowRuns.pause(run.id);
      else if (action === 'resume') next = await api.workflowRuns.resume(run.id);
      else if (action === 'stop') next = await api.workflowRuns.stop(run.id);
      else next = await api.workflowRuns.retry(run.id, action === 'retryFailed');
      upsertRun(next);
      if (action === 'retry' || action === 'retryFailed') onRetried?.(next);
    } catch (err) {
      notifyError(t(`automations.run.error.${action}`), err);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={['flex flex-col gap-3', className ?? ''].join(' ')}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={RUN_STATUS_TONE[run.status]} pulse={run.status === 'running' || run.status === 'awaiting_approval'} label={t(`run.status.${run.status}`)} />
        <span className="text-xs text-muted">
          {live ? t('automations.run.stepOf', { current: currentNumber, total: progress.total }) : t('automations.run.stepsDone', { done: progress.succeeded, total: progress.total })}
        </span>
        <span className="ms-auto flex items-center gap-1.5 text-xs text-muted tabular-nums">
          <RelativeTime at={run.startedAt} />
          <span aria-hidden>·</span>
          <span title={t('automations.run.duration')}>{formatClockDuration(runDurationMs(run, now))}</span>
        </span>
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-default"
        role="progressbar"
        aria-label={t('automations.run.progress')}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
      >
        <div
          className={[
            'h-full rounded-full transition-[width] duration-200',
            run.status === 'failed' ? 'bg-danger' : run.status === 'succeeded' ? 'bg-success' : live ? 'ai-gradient-bg' : 'bg-muted',
          ].join(' ')}
          style={{ width: `${Math.round(ratio * 1000) / 10}%` }}
        />
      </div>

      {run.retryOf ? <p className="text-[11px] text-muted">{t('automations.run.retryOf')}</p> : null}

      {/* Pause and Stop only reduce what runs, so every session gets them; Resume and Retry need control. */}
      {live || (canControl && retry.whole) ? (
        <div className="flex flex-wrap items-center gap-2">
          {live ? (
            <>
              {run.status === 'paused' ? (
                canControl ? (
                  <Button size="sm" variant="secondary" isPending={pending === 'resume'} isDisabled={pending !== null} onPress={() => void act('resume')}>
                    <CirclePlay className="size-3.5" />
                    {t('automations.run.resume')}
                  </Button>
                ) : null
              ) : (
                <Button size="sm" variant="secondary" isPending={pending === 'pause'} isDisabled={pending !== null} onPress={() => void act('pause')}>
                  <CirclePause className="size-3.5" />
                  {t('automations.run.pause')}
                </Button>
              )}
              <Button size="sm" variant="danger" isPending={pending === 'stop'} isDisabled={pending !== null} onPress={() => void act('stop')}>
                <CircleStop className="size-3.5" />
                {t('automations.run.stop')}
              </Button>
              {run.status === 'paused' && !canControl ? (
                <span className="text-[11px] text-muted">{t('automations.run.reason.viewOnly')}</span>
              ) : null}
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                isPending={pending === 'retry'}
                isDisabled={pending !== null || Boolean(retryBlockedReason)}
                onPress={() => void act('retry')}
              >
                <ArrowRotateLeft className="size-3.5" />
                {t('automations.run.retry')}
              </Button>
              {retry.fromFailed ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={pending === 'retryFailed'}
                  isDisabled={pending !== null || Boolean(retryBlockedReason)}
                  onPress={() => void act('retryFailed')}
                >
                  <ArrowRotateLeft className="size-3.5" />
                  {t('automations.run.retryFailed', { step: progress.failedIndex + 1 })}
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {!live && retry.whole && retryBlockedReason ? <p className="text-[11px] text-warning">{retryBlockedReason}</p> : null}
      {live ? <p className="text-[11px] text-muted">{t('automations.run.stopHint')}</p> : null}

      {run.error ? (
        <Notice tone="danger" icon={<TriangleExclamation />} title={t('automations.run.errorTitle')}>
          <span dir="auto" className="break-words whitespace-pre-wrap">
            {run.error}
          </span>
        </Notice>
      ) : null}

      <ol className="flex flex-col gap-1.5" aria-label={t('automations.run.stepsLabel')}>
        {run.steps.map((result, index) => (
          <RunStepRow
            key={`${result.stepId}-${index}`}
            index={index}
            result={result}
            step={stepsById.get(result.stepId) ?? null}
            now={now}
            locale={locale}
            onOpenShot={setShot}
          >
            {result.status === 'running' && approvals.length > 0 ? (
              <div className="mt-2 flex flex-col gap-2">
                {approvals.map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} compact />
                ))}
              </div>
            ) : null}
          </RunStepRow>
        ))}
      </ol>
      {/* Approvals not tied to a running step (e.g. arriving between status updates). */}
      {approvals.length > 0 && !run.steps.some((s) => s.status === 'running') ? (
        <div className="flex flex-col gap-2">
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} compact />
          ))}
        </div>
      ) : null}
      <ScreenshotModal shot={shot} onClose={() => setShot(null)} />
    </div>
  );
}

interface RunStepRowProps {
  index: number;
  result: StepRunResult;
  step: WorkflowStep | null;
  now: number;
  locale: string;
  onOpenShot: (shot: ScreenshotRef) => void;
  children?: ReactNode;
}

function RunStepRow({ index, result, step, now, locale, onOpenShot, children }: RunStepRowProps) {
  const { t, formatNumber } = useI18n();
  const duration = stepDurationMs(result, now);
  const title = step ? summarizeStep(step, t) : t('automations.run.stepRemoved');
  return (
    <li
      className={[
        'rounded-xl border p-2.5',
        result.status === 'running'
          ? 'ai-ring border-transparent bg-surface-secondary'
          : result.status === 'failed'
            ? 'border-danger/35 bg-danger/5'
            : 'border-hairline bg-surface-secondary/60',
      ].join(' ')}
    >
      <div className="flex items-start gap-2.5">
        <span role="img" className="mt-0.5 flex size-5 shrink-0 items-center justify-center" aria-label={t(`automations.stepStatus.${result.status}`)}>
          {STEP_STATUS_ICON[result.status]}
        </span>
        {step ? <StepIcon type={step.type} size="sm" /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p dir="auto" className={['min-w-0 flex-1 text-[13px] break-words', result.status === 'skipped' || result.status === 'pending' ? 'text-muted' : 'text-foreground'].join(' ')}>
              <span className="text-muted tabular-nums">{formatNumber(index + 1)}. </span>
              {title}
            </p>
            {duration !== null ? <span className="mt-0.5 shrink-0 text-[11px] text-muted tabular-nums">{formatDuration(duration, locale)}</span> : null}
          </div>
          {result.message ? (
            <p dir="auto" className={['mt-1 text-xs leading-relaxed break-words whitespace-pre-wrap', result.status === 'failed' ? 'text-danger' : 'text-muted'].join(' ')}>
              {result.message}
            </p>
          ) : null}
          {result.output ? (
            <div className="mt-2 rounded-lg border border-hairline bg-background/60 p-2">
              <p className="text-[11px] font-medium text-muted">
                {step?.type === 'read_screen' ? t('automations.run.savedAs', { name: `{${step.saveAs}}` }) : t('automations.run.output')}
              </p>
              <p dir="auto" className="mt-1 max-h-40 overflow-auto text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
                {result.output}
              </p>
            </div>
          ) : null}
          {result.screenshotId ? (
            <ScreenshotThumb id={result.screenshotId} title={title} onOpen={onOpenShot} className="mt-2" />
          ) : null}
          {children}
        </div>
      </div>
    </li>
  );
}
