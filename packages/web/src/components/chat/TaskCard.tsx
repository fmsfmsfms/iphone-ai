// One AI task, shown inline in the conversation after the assistant's reply
// (the reply carries the final summary, so it is never repeated here). A
// compact, quiet block: one status line (working / completed / failed / needs
// you / stopped … · actions · elapsed · verification), pause / resume / cancel
// and the live step while it runs, a one-line reason only for a specific
// cause the reply doesn't already state (plus a shortcut to the fix), and the
// step timeline — collapsed by default, with reasoning collapsed inside it.
// Pending approvals stay visible and actionable right under the card, the last
// thing in the turn. TaskStatusBar is the same running task in one line, for
// when the card is out of view.

import {
  ArrowRotateLeft,
  ChevronDown,
  CircleCheckFill,
  CircleMinus,
  CirclePause,
  CirclePlay,
  CircleXmark,
  CircleXmarkFill,
  Clock,
  Gear,
  Hand,
  OctagonXmark,
  ShieldCheck,
  ShieldExclamation,
  Smartphone,
  TriangleExclamation,
} from '@gravity-ui/icons';
import { TERMINAL_TASK_STATUSES, type AgentStep, type AgentTask } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import type { Tone } from '../../lib/device-state';
import { errorMessage } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { cancelTask, loadTask, notifyError, pauseTask, resumeTask, useCanControl, useTask, useTaskApprovals, useTaskSteps } from '../../state/store';
import { IconButton } from '../IconButton';
import { useNow } from '../RelativeTime';
import { StatusChip } from '../StatusChip';
import { ApprovalCard } from './ApprovalCard';
import { StepTimeline } from './StepTimeline';
import { useHoldScrollPosition } from './thread-scroll';
import {
  explainTaskFailure,
  formatElapsed,
  TASK_PHASE_KEY,
  TASK_PHASE_TONE,
  taskElapsedMs,
  taskPhase,
  type FailureAction,
  type FailureExplanation,
  type TaskPhase,
} from './task-ui';

export interface TaskCardProps {
  taskId: string;
  compact?: boolean;
  /** Sends the instruction again; omitted when retrying isn't offered (e.g. for older tasks). */
  onRetry?: (instruction: string) => Promise<void>;
  /** Translated reason why a retry can't be sent right now. */
  retryDisabledReason?: string | null;
  /** The task has no reply message (e.g. it ended before starting): show its outcome here instead. */
  showSummary?: boolean;
  /** Show the instruction (for a task shown without the message that started it). */
  showInstruction?: boolean;
  /** Hide the "Open Live Control" shortcut (already on Live Control). */
  hideLiveAction?: boolean;
  /** The reply shown above the card: a failure it already states gets no reason line. */
  reply?: string;
  className?: string;
}

const PHASE_ICON: Record<Exclude<TaskPhase, 'running'>, ReactNode> = {
  queued: <Clock />,
  paused: <CirclePause />,
  awaiting_approval: <ShieldExclamation />,
  completed: <CircleCheckFill />,
  failed: <CircleXmarkFill />,
  cancelled: <CircleMinus />,
  stopped: <OctagonXmark />,
  needsYou: <Hand />,
  unsuccessful: <TriangleExclamation />,
};

const TONE_TEXT: Record<Tone, string> = {
  default: 'text-muted',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  ai: 'text-ai-purple',
};

/**
 * Failure kinds the coloured status label already says ("Failed",
 * "Cancelled", "Stopped", "Needs you", "Didn't succeed") and the reply
 * explains: no reason line, no advice.
 */
const SAID_BY_STATUS = new Set<FailureExplanation['kind']>(['generic', 'unsuccessful', 'cancelled', 'stopped', 'emergencyStop', 'needsUser']);

type PendingAction = 'pause' | 'resume' | 'cancel' | null;

export function TaskCard({ taskId, compact, onRetry, retryDisabledReason, showSummary, showInstruction, hideLiveAction, reply, className }: TaskCardProps) {
  const { t } = useI18n();
  const task = useTask(taskId);
  const steps = useTaskSteps(taskId);
  const approvals = useTaskApprovals(taskId);
  const terminal = task ? TERMINAL_TASK_STATUSES.includes(task.status) : false;
  const [expanded, setExpanded] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const stepsId = useId();
  const holdScrollPosition = useHoldScrollPosition();
  const timeline = useMemo(() => withoutRepeatedSummary(steps, task), [steps, task]);

  // The task (when it isn't in the store yet) and its steps load on first expand —
  // or right away while it runs, so the live step is there.
  const wantSteps = expanded || (task !== null && !terminal);
  useEffect(() => {
    if (loadState !== 'idle' || (task && !wantSteps)) return;
    setLoadState('loading');
    loadTask(taskId)
      .then(() => setLoadState('loaded'))
      .catch((err: unknown) => {
        setLoadError(errorMessage(err));
        setLoadState('error');
      });
  }, [loadState, task, taskId, wantSteps]);

  if (!task) {
    return (
      <div className={['flex items-center gap-2 py-1 text-xs text-muted', className ?? ''].join(' ')} role="status">
        {loadState === 'error' ? (
          <span className="text-danger">{loadError}</span>
        ) : (
          <>
            <Spinner size="sm" color="current" />
            {t('task.loading')}
          </>
        )}
      </div>
    );
  }

  const failure = explainTaskFailure(task);
  const phase = taskPhase(task, failure);
  const tone = TASK_PHASE_TONE[phase];
  const live = liveStep(task, steps, approvals.length);
  const summary = showSummary && terminal ? (task.outcome?.summary ?? task.error ?? null) : null;
  const extraError = showSummary && task.error && task.error.trim() !== summary?.trim() ? task.error : null;
  // A specific cause (provider busy, network, mirroring …): its advice waits with the steps, and its
  // one-line title shows only when the reply doesn't already state the error.
  const cause = failure && !SAID_BY_STATUS.has(failure.kind) ? failure : null;
  const stated = Boolean(task.error?.trim() && reply?.includes(task.error.trim()));
  const fixAction = cause && !(hideLiveAction && cause.action === 'live') ? cause.action : null;
  const canRetry = Boolean(failure?.canRetry && onRetry);
  const pad = compact ? 'px-3' : 'px-3.5';

  return (
    <div className={['flex w-full min-w-0 flex-col gap-2', className ?? ''].join(' ')}>
      <section
        aria-label={t('task.label')}
        // The running task's strip moves focus here when it brings the card back into view.
        tabIndex={-1}
        className={[
          'w-full min-w-0 overflow-hidden rounded-xl border bg-surface/70 outline-none focus-visible:ring-2 focus-visible:ring-focus',
          task.status === 'running' ? 'ai-ring border-transparent' : 'border-hairline',
        ].join(' ')}
      >
        <div
          // The conversation shows TaskStatusBar while this row is out of view.
          data-live-task={terminal ? undefined : task.id}
          className={['flex items-start gap-2.5', pad, compact ? 'py-2.5' : 'py-3'].join(' ')}
        >
          <span aria-hidden className={['flex size-5 shrink-0 items-center justify-center [&>svg]:size-4', TONE_TEXT[tone]].join(' ')}>
            {phase === 'running' ? <Spinner size="sm" color="current" /> : PHASE_ICON[phase]}
          </span>
          <div className="min-w-0 flex-1">
            <StatusLine task={task} phase={phase} tone={tone} terminal={terminal} />

            {showInstruction ? (
              <p dir="auto" className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-foreground">
                {task.instruction}
              </p>
            ) : null}

            {live ? (
              <p className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted">
                <span aria-hidden className="status-dot status-dot--pulse shrink-0 text-ai-purple" />
                <span className="truncate" dir="auto">
                  {live}
                </span>
              </p>
            ) : null}

            {summary ? (
              <p dir="auto" className="mt-1.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
                {summary}
              </p>
            ) : null}
            {extraError ? (
              <p dir="auto" className="mt-1 text-xs leading-relaxed break-words text-muted">
                {extraError}
              </p>
            ) : null}

            {cause && !stated ? (
              <FailureReason failure={cause} action={fixAction} />
            ) : fixAction ? (
              <div className="mt-1">
                <FailureActionButton action={fixAction} />
              </div>
            ) : null}
          </div>
          {!terminal ? <TaskControls task={task} /> : null}
        </div>

        <div className={['flex min-w-0 items-center gap-1 border-t border-hairline', compact ? 'pe-1.5' : 'pe-2'].join(' ')}>
          <button
            type="button"
            onClick={(e) => {
              holdScrollPosition(e.currentTarget);
              setExpanded(!expanded);
            }}
            aria-expanded={expanded}
            aria-controls={stepsId}
            className={[
              'app-transition flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-start text-xs text-muted outline-none',
              'hover:bg-hover hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
              pad,
              compact ? 'py-1.5' : 'py-2',
            ].join(' ')}
          >
            <ChevronDown aria-hidden className={['size-3.5 shrink-0 transition-transform duration-200', expanded ? 'rotate-180' : ''].join(' ')} />
            <span className="truncate">{expanded ? t('task.steps.hide') : t('task.steps.show', { count: steps.length || null })}</span>
          </button>
          {canRetry ? <RetryButton instruction={task.instruction} onRetry={onRetry!} disabledReason={retryDisabledReason ?? null} /> : null}
        </div>

        {expanded ? (
          <div id={stepsId} className={['border-t border-hairline pt-3', pad].join(' ')}>
            <p className="mb-2.5 text-[11px] leading-snug break-words text-muted">
              <bdi>
                {task.providerLabel}
                {task.model ? ` · ${task.model}` : ''}
              </bdi>
            </p>
            {cause ? <p className="mb-3 text-xs leading-relaxed text-muted">{t(cause.bodyKey)}</p> : null}
            {loadState === 'loading' && steps.length === 0 ? (
              <p className="flex items-center gap-2 pb-3 text-xs text-muted" role="status">
                <Spinner size="sm" color="current" />
                {t('steps.loading')}
              </p>
            ) : loadState === 'error' && steps.length === 0 ? (
              <p className="pb-3 text-xs text-danger">{loadError}</p>
            ) : steps.length === 0 ? (
              <p className="pb-3 text-xs text-muted">{terminal ? t('task.steps.none') : t('steps.empty.body')}</p>
            ) : (
              <StepTimeline taskId={taskId} steps={timeline} compact={compact} />
            )}
          </div>
        ) : null}
      </section>

      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} compact={compact} />
      ))}
    </div>
  );
}

/** What the AI is doing right now — nothing while an approval card says what it waits for. */
function liveStep(task: AgentTask, steps: AgentStep[], pendingApprovals: number): string | null {
  if (TERMINAL_TASK_STATUSES.includes(task.status) || pendingApprovals > 0) return null;
  return task.currentActivity ?? steps.at(-1)?.title ?? null;
}

export interface TaskStatusBarProps {
  taskId: string;
  compact?: boolean;
  /** Brings the task's card back into view. */
  onReveal: () => void;
  className?: string;
}

/**
 * A running task in one line — status, live step, pause / resume / cancel —
 * under the conversation while its card is out of view, so it can always be
 * stopped. Nothing once the task has ended.
 */
export function TaskStatusBar({ taskId, compact, onReveal, className }: TaskStatusBarProps) {
  const { t } = useI18n();
  const task = useTask(taskId);
  const steps = useTaskSteps(taskId);
  const approvals = useTaskApprovals(taskId);
  if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) return null;
  const phase = taskPhase(task);
  const tone = TASK_PHASE_TONE[phase];
  // Only while it works: paused / waiting, the label (and Resume, or the approval) says it all.
  const live = phase === 'running' ? liveStep(task, steps, approvals.length) : null;
  const label = t(TASK_PHASE_KEY[phase]);
  return (
    <section
      aria-label={t('task.bar.label')}
      className={['flex min-w-0 items-center gap-2 border-t border-hairline bg-surface/70', compact ? 'py-1.5' : 'py-2', className ?? ''].join(' ')}
    >
      <span aria-hidden className={['flex size-5 shrink-0 items-center justify-center [&>svg]:size-4', TONE_TEXT[tone]].join(' ')}>
        {phase === 'running' ? <Spinner size="sm" color="current" /> : PHASE_ICON[phase]}
      </span>
      <button
        type="button"
        onClick={onReveal}
        title={t('task.bar.show')}
        className="app-transition min-w-0 flex-1 truncate rounded-md py-1 text-start text-xs text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className={['text-[13px] font-semibold', tone === 'warning' ? TONE_TEXT[tone] : 'text-foreground'].join(' ')}>{label}</span>
        {live ? (
          <>
            <span aria-hidden> · </span>
            <bdi>{live}</bdi>
          </>
        ) : null}
      </button>
      <TaskControls task={task} />
    </section>
  );
}

/**
 * The closing check / error step starts with the same text as the task's
 * outcome, which the reply already shows: keep the step and anything it adds
 * (e.g. the evidence), drop the repeated text.
 */
function withoutRepeatedSummary(steps: AgentStep[], task: AgentTask | null): AgentStep[] {
  const repeated = [task?.outcome?.summary, task?.error].flatMap((text) => (text?.trim() ? [text.trim()] : []));
  if (repeated.length === 0) return steps;
  return steps.map((step) => {
    if ((step.type !== 'verify' && step.type !== 'error') || !step.detail) return step;
    const detail = step.detail.trim();
    const match = repeated.find((text) => detail.startsWith(text));
    if (!match) return step;
    const rest = detail.slice(match.length).trim();
    return { ...step, detail: rest || null };
  });
}

/** "Failed · 7 of 25 actions · 4m 12s" and, once completed, whether the final screen confirmed it. */
function StatusLine({ task, phase, tone, terminal }: { task: AgentTask; phase: TaskPhase; tone: Tone; terminal: boolean }) {
  const { t } = useI18n();
  // Only a running task needs a ticking clock.
  const now = useNow(terminal ? 3_600_000 : 1000);
  const elapsed = taskElapsedMs(task, now);
  const outcome = task.status === 'completed' ? task.outcome : null;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-5 text-muted">
      <span className={['text-[13px] font-semibold', tone === 'danger' || tone === 'warning' ? TONE_TEXT[tone] : 'text-foreground'].join(' ')}>
        {t(TASK_PHASE_KEY[phase])}
      </span>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span aria-hidden>·</span>
        <span>{t('task.actions', { used: task.actionsUsed, max: task.maxActions })}</span>
      </span>
      {elapsed !== null ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <span aria-hidden>·</span>
          <span aria-live="off" className="tabular-nums">
            {formatElapsed(elapsed, t)}
          </span>
        </span>
      ) : null}
      {outcome?.verified ? (
        <StatusChip tone="success" size="sm" hideDot icon={<ShieldCheck />} label={t('task.verified')} tooltip={t('task.verifiedHint')} className="ms-0.5" />
      ) : outcome?.success ? (
        <StatusChip tone="warning" size="sm" hideDot icon={<TriangleExclamation />} label={t('task.notVerified')} tooltip={t('task.notVerifiedHint')} className="ms-0.5" />
      ) : null}
    </p>
  );
}

/** Pause / resume / cancel. Pausing and cancelling only reduce what the AI does, so view-only sessions get them too. */
function TaskControls({ task }: { task: AgentTask }) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const [pending, setPending] = useState<PendingAction>(null);
  const running = task.status === 'running' || task.status === 'awaiting_approval' || task.status === 'queued';

  const run = async (action: Exclude<PendingAction, null>) => {
    setPending(action);
    try {
      if (action === 'pause') await pauseTask(task.id);
      else if (action === 'resume') await resumeTask(task.id);
      else await cancelTask(task.id);
    } catch (err) {
      notifyError(t(`task.error.${action}`), err);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="-me-1.5 -my-1 flex shrink-0 items-center">
      {task.status === 'paused' ? (
        <IconButton
          label={t('task.resume')}
          icon={<CirclePlay />}
          isPending={pending === 'resume'}
          isDisabled={!canControl}
          disabledReason={!canControl ? t('input.reason.viewOnly') : null}
          onPress={() => void run('resume')}
        />
      ) : (
        <IconButton label={t('task.pause')} icon={<CirclePause />} isPending={pending === 'pause'} isDisabled={!running} onPress={() => void run('pause')} />
      )}
      <IconButton label={t('task.cancel')} icon={<CircleXmark />} isPending={pending === 'cancel'} onPress={() => void run('cancel')} className="hover:text-danger" />
    </div>
  );
}

/** Why the task didn't succeed, in one line, with a shortcut to the fix (the advice is with the steps). */
function FailureReason({ failure, action }: { failure: FailureExplanation; action: FailureAction }) {
  const { t } = useI18n();
  return (
    <div role="note" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
      <p className="text-xs leading-5 text-foreground/85">{t(failure.titleKey)}</p>
      <FailureActionButton action={action} />
    </div>
  );
}

function RetryButton({
  instruction,
  onRetry,
  disabledReason,
}: {
  instruction: string;
  onRetry: (instruction: string) => Promise<void>;
  disabledReason: string | null;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry(instruction);
    } catch {
      // The sender already showed the error.
    } finally {
      setRetrying(false);
    }
  };
  return (
    <IconButton
      label={t('task.retry')}
      icon={<ArrowRotateLeft />}
      showLabel
      isPending={retrying}
      isDisabled={Boolean(disabledReason)}
      disabledReason={disabledReason}
      onPress={() => void retry()}
      className="h-7 shrink-0 gap-1.5 px-2 text-xs [&_svg]:size-3.5"
    />
  );
}

function FailureActionButton({ action }: { action: FailureAction }) {
  const { t } = useI18n();
  const props = { size: 'sm', variant: 'ghost', className: 'h-6 gap-1 px-1.5 text-xs text-accent' } as const;
  if (action === 'settings-ai') {
    return (
      <Button {...props} onPress={() => navigate({ name: 'settings', section: 'ai' })}>
        <Gear className="size-3.5" />
        {t('provider.manage')}
      </Button>
    );
  }
  if (action === 'live') {
    return (
      <Button {...props} onPress={() => navigate({ name: 'live' })}>
        <Smartphone className="size-3.5" />
        {t('task.action.openLive')}
      </Button>
    );
  }
  if (action === 'dashboard') {
    return (
      <Button {...props} onPress={() => navigate({ name: 'dashboard' })}>
        {t('task.action.checkConnection')}
      </Button>
    );
  }
  return null;
}
