// Chronological steps of an AI task: observations, reasoning (collapsed), tool
// calls with redacted args / result / duration, approvals, verification.

import {
  ChevronDown,
  CircleCheck,
  Comment,
  Eye,
  Hand,
  Picture,
  Shield,
  ShieldCheck,
  Sparkles,
  TriangleExclamation,
} from '@gravity-ui/icons';
import type { AgentStep, AgentStepType } from '@iphone-ai/shared';
import { Button, Modal, Spinner } from '@heroui/react';
import { useEffect, useState, type ReactNode } from 'react';

import { api, errorMessage } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { loadTask, useTaskSteps } from '../../state/store';
import { EmptyState } from '../EmptyState';
import { RelativeTime } from '../RelativeTime';
import { StatusChip } from '../StatusChip';
import { formatArgs, formatDuration, STEP_TYPE_KEY } from './task-ui';
import { useHoldScrollPosition } from './thread-scroll';

const STEP_ICON: Record<AgentStepType, ReactNode> = {
  observe: <Eye />,
  reasoning: <Sparkles />,
  tool_call: <Hand />,
  approval: <ShieldCheck />,
  verify: <CircleCheck />,
  policy: <Shield />,
  message: <Comment />,
  error: <TriangleExclamation />,
};

const STEP_ICON_TONE: Record<AgentStepType, string> = {
  observe: 'bg-default text-muted',
  reasoning: 'ai-soft-bg text-ai-purple',
  tool_call: 'bg-accent/15 text-accent',
  approval: 'bg-warning/15 text-warning',
  verify: 'bg-success/15 text-success',
  policy: 'bg-warning/15 text-warning',
  message: 'bg-default text-foreground',
  error: 'bg-danger/15 text-danger',
};

export interface StepTimelineProps {
  taskId: string;
  /** Steps to show; defaults to the store's steps for the task (loaded on mount if missing). */
  steps?: AgentStep[];
  compact?: boolean;
  /** Only show the most recent N steps (compact panels). */
  limit?: number;
  className?: string;
}

export function StepTimeline({ taskId, steps: provided, compact, limit, className }: StepTimelineProps) {
  const { t } = useI18n();
  const stored = useTaskSteps(taskId);
  const steps = provided ?? stored;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AgentStep | null>(null);

  useEffect(() => {
    if (provided) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadTask(taskId)
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, provided]);

  const visible = limit && steps.length > limit ? steps.slice(-limit) : steps;
  const hidden = steps.length - visible.length;

  if (steps.length === 0) {
    if (loading) {
      return (
        <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted">
          <Spinner size="sm" />
          {t('steps.loading')}
        </div>
      );
    }
    if (error) return <p className="px-1 py-2 text-xs text-danger">{error}</p>;
    return <EmptyState size="sm" icon={<Sparkles />} title={t('steps.empty.title')} description={t('steps.empty.body')} />;
  }

  return (
    <div className={className}>
      {hidden > 0 ? <p className="mb-2 px-1 text-[11px] text-muted">{t('steps.hidden', { count: hidden })}</p> : null}
      <ol className="relative flex flex-col" aria-label={t('steps.label')}>
        {visible.map((step, i) => (
          <StepRow
            key={step.id}
            step={step}
            compact={compact}
            isLast={i === visible.length - 1}
            onPreview={() => setPreview(step)}
          />
        ))}
      </ol>
      <ScreenshotPreview step={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

function StepRow({ step, compact, isLast, onPreview }: { step: AgentStep; compact?: boolean; isLast: boolean; onPreview: () => void }) {
  const { t, locale } = useI18n();
  const tool = step.tool;
  const args = formatArgs(tool?.args);
  const isReasoning = step.type === 'reasoning';
  const holdScrollPosition = useHoldScrollPosition();

  return (
    <li className="relative flex gap-3 pb-3">
      {!isLast ? <span aria-hidden className="absolute start-3.5 top-8 bottom-0 w-px bg-hairline" /> : null}
      <span
        aria-hidden
        className={['relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full [&>svg]:size-3.5', STEP_ICON_TONE[step.type]].join(' ')}
      >
        {STEP_ICON[step.type]}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p dir="auto" className={['font-medium text-foreground', compact ? 'text-[13px]' : 'text-sm'].join(' ')}>
            {step.title}
          </p>
          <span className="text-[11px] text-muted">
            {t(STEP_TYPE_KEY[step.type])} · <RelativeTime at={step.createdAt} />
          </span>
        </div>

        {step.detail && !isReasoning ? (
          <p dir="auto" className="mt-1 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted">
            {step.detail}
          </p>
        ) : null}

        {step.detail && isReasoning ? (
          <details className="group mt-1">
            <summary
              onClick={(e) => holdScrollPosition(e.currentTarget)}
              className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted select-none hover:text-foreground"
            >
              <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
              {t('steps.showReasoning')}
            </summary>
            <p dir="auto" className="mt-1.5 rounded-lg bg-default/50 p-2.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted">
              {step.detail}
            </p>
          </details>
        ) : null}

        {tool ? (
          <div className="mt-2 rounded-xl border border-hairline bg-background/60 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-md bg-default px-1.5 py-0.5 font-mono text-[11px] text-foreground">{tool.name}</code>
              {tool.ok === true ? <StatusChip tone="success" size="sm" label={t('steps.ok')} /> : null}
              {tool.ok === false ? <StatusChip tone="danger" size="sm" label={t('steps.failed')} /> : null}
              {tool.ok === null ? <StatusChip tone="ai" size="sm" pulse label={t('steps.running')} /> : null}
              {tool.durationMs !== null ? <span className="text-[11px] text-muted">{formatDuration(tool.durationMs, locale)}</span> : null}
            </div>
            {args ? (
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-default/40 p-2 font-mono text-[11px] leading-relaxed text-muted" dir="ltr">
                {args}
              </pre>
            ) : null}
            {tool.result ? (
              <p dir="auto" className="mt-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
                {tool.result}
              </p>
            ) : null}
          </div>
        ) : null}

        {step.screenshotId ? (
          <button
            type="button"
            onClick={onPreview}
            className="app-transition mt-2 block overflow-hidden rounded-lg border border-hairline hover:border-hairline-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            aria-label={t('steps.openScreenshot')}
          >
            <img
              src={api.screen.screenshotUrl(step.screenshotId)}
              alt={t('steps.screenshotAlt', { title: step.title })}
              loading="lazy"
              className={['bg-black object-contain', compact ? 'h-24 w-auto' : 'h-36 w-auto'].join(' ')}
            />
          </button>
        ) : null}
      </div>
    </li>
  );
}

function ScreenshotPreview({ step, onClose }: { step: AgentStep | null; onClose: () => void }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [step?.screenshotId]);
  return (
    <Modal.Backdrop isOpen={Boolean(step?.screenshotId)} onOpenChange={(open) => !open && onClose()} variant="blur">
      <Modal.Container size="lg" placement="center">
        <Modal.Dialog className="app-panel bg-overlay">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading className="flex items-center gap-2 text-base">
              <Picture className="size-4 text-muted" />
              {step?.title ?? ''}
            </Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex justify-center">
            {step?.screenshotId && !failed ? (
              <img
                src={api.screen.screenshotUrl(step.screenshotId)}
                alt={t('steps.screenshotAlt', { title: step.title })}
                className="max-h-[70vh] w-auto rounded-xl bg-black object-contain"
                onError={() => setFailed(true)}
              />
            ) : (
              <EmptyState size="sm" icon={<Picture />} title={t('steps.screenshotGone.title')} description={t('steps.screenshotGone.body')} />
            )}
          </Modal.Body>
          <Modal.Footer className="flex justify-end">
            <Button variant="secondary" slot="close">
              {t('common.close')}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
