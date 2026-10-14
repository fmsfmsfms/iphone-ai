// Everything about one AI task, shown under the instruction that started it:
// progress with pause/resume/cancel, the verification result, a readable
// explanation when it didn't succeed (with a retry), and the step timeline —
// actual MCP tool calls, collapsed reasoning, screenshots — with pending
// approvals placed where they were requested.

import { ArrowRotateLeft, ChevronDown, CircleCheckFill, Gear, ShieldCheck, Smartphone, TriangleExclamation } from '@gravity-ui/icons';
import { TERMINAL_TASK_STATUSES } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useEffect, useMemo, useState } from 'react';

import { ApprovalCard, StepTimeline, TaskProgress } from '../../components/chat';
import { StatusChip } from '../../components/StatusChip';
import { errorMessage } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { loadTask, useTask, useTaskApprovals, useTaskSteps } from '../../state/store';
import { explainTaskFailure, interleaveApprovals, type FailureAction } from './assistant-utils';

export interface TaskBlockProps {
  taskId: string;
  /** Expanded by default (the newest task in the conversation). */
  defaultExpanded: boolean;
  /** Sends the instruction again; omitted when retrying isn't possible. */
  onRetry?: (instruction: string) => Promise<void>;
  /** Translated reason why a retry can't be sent right now. */
  retryDisabledReason?: string | null;
}

export function TaskBlock({ taskId, defaultExpanded, onRetry, retryDisabledReason }: TaskBlockProps) {
  const { t } = useI18n();
  const task = useTask(taskId);
  const steps = useTaskSteps(taskId);
  const approvals = useTaskApprovals(taskId);
  const terminal = task ? TERMINAL_TASK_STATUSES.includes(task.status) : false;
  const [expandedState, setExpanded] = useState(defaultExpanded);
  const expanded = expandedState || !terminal || approvals.length > 0;
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Steps (and the task itself, when it isn't in the store yet) load on first expand.
  useEffect(() => {
    if ((!expanded && task) || loadState !== 'idle') return;
    setLoadState('loading');
    loadTask(taskId)
      .then(() => setLoadState('loaded'))
      .catch((err: unknown) => {
        setLoadError(errorMessage(err));
        setLoadState('error');
      });
  }, [expanded, loadState, task, taskId]);

  const timeline = useMemo(() => interleaveApprovals(steps, approvals), [steps, approvals]);
  const failure = task ? explainTaskFailure(task) : null;

  if (!task) {
    return (
      <div className="ms-9 flex items-center gap-2 text-xs text-muted">
        {loadState === 'error' ? (
          <span className="text-danger">{loadError}</span>
        ) : (
          <>
            <Spinner size="sm" />
            {t('assistant.task.loading')}
          </>
        )}
      </div>
    );
  }

  const retry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry(task.instruction);
    } catch {
      // The sender already showed the error.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="ms-9 flex flex-col gap-2.5">
      <TaskProgress task={task} />

      {terminal && task.status === 'completed' && task.outcome?.success ? (
        <div className="flex flex-wrap items-center gap-2 px-1">
          {task.outcome.verified ? (
            <StatusChip tone="success" size="sm" hideDot icon={<ShieldCheck />} label={t('assistant.task.verified')} tooltip={t('assistant.task.verifiedHint')} />
          ) : (
            <StatusChip tone="warning" size="sm" hideDot icon={<TriangleExclamation />} label={t('assistant.task.notVerified')} tooltip={t('assistant.task.notVerifiedHint')} />
          )}
        </div>
      ) : null}

      {failure ? (
        <div role="note" className="rounded-2xl border border-warning/30 bg-warning/8 p-3.5">
          <div className="flex items-start gap-2.5">
            <TriangleExclamation className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-foreground">{t(failure.titleKey)}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{t(failure.bodyKey)}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {failure.canRetry && onRetry ? (
                  <Button size="sm" variant="secondary" isPending={retrying} isDisabled={Boolean(retryDisabledReason) || retrying} onPress={() => void retry()}>
                    <ArrowRotateLeft className="size-3.5" />
                    {t('assistant.task.retry')}
                  </Button>
                ) : null}
                <FailureActionButton action={failure.action} />
              </div>
              {failure.canRetry && onRetry && retryDisabledReason ? <p className="mt-1.5 text-[11px] text-muted">{retryDisabledReason}</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          disabled={!terminal || approvals.length > 0}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 rounded-md text-xs text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default disabled:hover:text-muted"
        >
          <ChevronDown className={['size-3.5 transition-transform duration-200', expanded ? 'rotate-180' : ''].join(' ')} />
          {expanded ? t('assistant.task.hideSteps') : t('assistant.task.showSteps', { count: steps.length || null })}
        </button>
        {terminal && task.status === 'completed' && task.outcome?.success ? <CircleCheckFill className="size-3.5 text-success" aria-hidden /> : null}
      </div>

      {expanded ? (
        <div className="rounded-2xl border border-hairline bg-surface/60 p-3">
          {loadState === 'loading' && steps.length === 0 ? (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted" role="status">
              <Spinner size="sm" />
              {t('steps.loading')}
            </div>
          ) : loadState === 'error' && steps.length === 0 ? (
            <p className="px-1 py-2 text-xs text-danger">{loadError}</p>
          ) : timeline.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted">{terminal ? t('assistant.task.noSteps') : t('steps.empty.body')}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {timeline.map((item) =>
                item.kind === 'steps' ? (
                  <StepTimeline key={item.key} taskId={taskId} steps={item.steps} />
                ) : (
                  <ApprovalCard key={item.key} approval={item.approval} className="mb-3" />
                ),
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FailureActionButton({ action }: { action: FailureAction }) {
  const { t } = useI18n();
  if (action === 'settings-ai') {
    return (
      <Button size="sm" variant="ghost" onPress={() => navigate({ name: 'settings', section: 'ai' })}>
        <Gear className="size-3.5" />
        {t('provider.manage')}
      </Button>
    );
  }
  if (action === 'live') {
    return (
      <Button size="sm" variant="ghost" onPress={() => navigate({ name: 'live' })}>
        <Smartphone className="size-3.5" />
        {t('assistant.action.openLive')}
      </Button>
    );
  }
  if (action === 'dashboard') {
    return (
      <Button size="sm" variant="ghost" onPress={() => navigate({ name: 'dashboard' })}>
        {t('assistant.action.checkConnection')}
      </Button>
    );
  }
  return null;
}
