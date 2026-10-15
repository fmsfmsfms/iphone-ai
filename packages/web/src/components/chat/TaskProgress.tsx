// Status of one AI task as a standalone card (Dashboard): state,
// provider/model, action budget, current activity, outcome — with pause /
// resume / cancel. Pausing and cancelling only reduce what the AI does, so
// every session (view-only too) gets them; resuming needs a session that can
// control. Inside a conversation, TaskCard shows the task inline instead.

import { CircleCheckFill, CirclePause, CirclePlay, CircleXmark, Sparkles, TriangleExclamation } from '@gravity-ui/icons';
import { TERMINAL_TASK_STATUSES, type AgentTask } from '@iphone-ai/shared';
import { Button } from '@heroui/react';
import { useState } from 'react';

import { useI18n } from '../../lib/i18n';
import { cancelTask, notifyError, pauseTask, resumeTask, useCanControl } from '../../state/store';
import { RelativeTime } from '../RelativeTime';
import { StatusChip } from '../StatusChip';
import { TASK_STATUS_KEY, TASK_STATUS_TONE } from './task-ui';

export interface TaskProgressProps {
  task: AgentTask;
  compact?: boolean;
  className?: string;
}

type PendingAction = 'pause' | 'resume' | 'cancel' | null;

export function TaskProgress({ task, compact, className }: TaskProgressProps) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const [pending, setPending] = useState<PendingAction>(null);
  const terminal = TERMINAL_TASK_STATUSES.includes(task.status);
  const running = task.status === 'running' || task.status === 'awaiting_approval' || task.status === 'queued';
  const ratio = task.maxActions > 0 ? Math.min(1, task.actionsUsed / task.maxActions) : 0;

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
    <div
      className={[
        'rounded-2xl border bg-surface-secondary',
        task.status === 'running' ? 'ai-ring border-transparent' : 'border-hairline',
        compact ? 'p-3' : 'p-4',
        className ?? '',
      ].join(' ')}
      aria-label={t('task.label')}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="ai-gradient-bg mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-white [&>svg]:size-3.5">
          <Sparkles />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              tone={TASK_STATUS_TONE[task.status]}
              label={t(TASK_STATUS_KEY[task.status])}
              pulse={task.status === 'running' || task.status === 'awaiting_approval'}
              size="sm"
            />
            <span className="truncate text-xs text-muted" title={`${task.providerLabel} · ${task.model}`}>
              {task.providerLabel}
              {task.model ? ` · ${task.model}` : ''}
            </span>
          </div>
          <p dir="auto" className={['mt-1.5 text-foreground', compact ? 'line-clamp-2 text-[13px]' : 'text-sm'].join(' ')}>
            {task.instruction}
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted">
          <span>{t('task.actions', { used: task.actionsUsed, max: task.maxActions })}</span>
          <span>
            {task.startedAt ? <RelativeTime at={task.startedAt} /> : t('task.notStarted')}
          </span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-default"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={task.maxActions}
          aria-valuenow={task.actionsUsed}
          aria-label={t('task.budget')}
        >
          <div
            className={['h-full rounded-full transition-[width] duration-200', ratio >= 0.9 ? 'bg-warning' : 'ai-gradient-bg'].join(' ')}
            style={{ width: `${Math.round(ratio * 1000) / 10}%` }}
          />
        </div>
      </div>

      {task.currentActivity && !terminal ? (
        <p className="mt-2.5 flex items-center gap-2 text-xs text-muted">
          <span aria-hidden className="status-dot status-dot--pulse text-ai-purple" />
          <span className="truncate" dir="auto">
            {task.currentActivity}
          </span>
        </p>
      ) : null}

      {terminal && task.outcome ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-default/50 p-2.5 text-[13px]">
          {task.outcome.success ? (
            <CircleCheckFill className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <TriangleExclamation className="mt-0.5 size-4 shrink-0 text-warning" />
          )}
          <div className="min-w-0">
            <p className="text-foreground" dir="auto">
              {task.outcome.summary}
            </p>
            <p className="mt-0.5 text-[11px] text-muted">
              {task.outcome.verified ? t('task.outcome.verified') : t('task.outcome.unverified')}
            </p>
          </div>
        </div>
      ) : null}

      {/* The backend often stores the same text as error and outcome summary: show it once. */}
      {task.error && !(terminal && task.outcome && task.outcome.summary.trim() === task.error.trim()) ? (
        <p role="alert" dir="auto" className="mt-3 rounded-xl bg-danger/10 px-2.5 py-2 text-[13px] text-danger">
          {task.error}
        </p>
      ) : null}

      {!terminal ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {task.status === 'paused' ? (
            canControl ? (
              <Button size="sm" variant="secondary" isPending={pending === 'resume'} onPress={() => void run('resume')}>
                <CirclePlay className="size-3.5" />
                {t('task.resume')}
              </Button>
            ) : null
          ) : (
            <Button size="sm" variant="secondary" isPending={pending === 'pause'} isDisabled={!running} onPress={() => void run('pause')}>
              <CirclePause className="size-3.5" />
              {t('task.pause')}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-danger" isPending={pending === 'cancel'} onPress={() => void run('cancel')}>
            <CircleXmark className="size-3.5" />
            {t('task.cancel')}
          </Button>
          {task.status === 'paused' && !canControl ? <span className="text-[11px] text-muted">{t('input.reason.viewOnly')}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
