// Automations home: saved workflows as cards (steps, last run, last success,
// source), plus New / Suggest with AI / Record, the recorder banner and the
// active run.

import { CircleFill, CirclePlay, ListCheck, Plus, Sparkles, Thunderbolt, TriangleExclamation } from '@gravity-ui/icons';
import type { Workflow } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';

import { EmptyState } from '../../components/EmptyState';
import { Page } from '../../components/Page';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { useI18n } from '../../lib/i18n';
import { href, navigate } from '../../lib/router';
import { useActiveRun, useCanControl } from '../../state/store';
import { ModeNotice } from './ModeNotice';
import { RecorderBanner, type RecorderApi } from './Recorder';
import { SourceBadge } from './SourceBadge';
import { stepNeedsAi } from './step-meta';
import { RUN_STATUS_TONE, runProgress } from './workflow-utils';

export interface WorkflowListProps {
  workflows: Workflow[] | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onNew: () => void;
  onSuggest: () => void;
  onRecord: () => void;
  recorder: RecorderApi;
  onRecordingSaved: (workflow: Workflow) => void;
}

export function WorkflowList({ workflows, loading, error, onReload, onNew, onSuggest, onRecord, recorder, onRecordingSaved }: WorkflowListProps) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const activeRun = useActiveRun();
  const recording = recorder.status?.recording ?? false;

  const actions = (
    <>
      <Button size="sm" variant="secondary" isDisabled={!canControl || recording} onPress={onRecord}>
        <CircleFill className="size-3 text-danger" />
        {t('automations.record')}
      </Button>
      <Button size="sm" variant="secondary" isDisabled={!canControl} onPress={onSuggest}>
        <Sparkles className="size-3.5" />
        {t('automations.suggestButton')}
      </Button>
      <Button size="sm" variant="primary" isDisabled={!canControl} onPress={onNew}>
        <Plus className="size-3.5" />
        {t('automations.new')}
      </Button>
    </>
  );

  return (
    <Page title={t('automations.title')} description={t('automations.description')} icon={<Thunderbolt />} actions={actions}>
      <div className="flex flex-col gap-5">
        <RecorderBanner recorder={recorder} onSaved={onRecordingSaved} />

        {activeRun ? (
          <div className="ai-ring flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-3 ps-4">
            <span aria-hidden className="ai-gradient-bg flex size-8 shrink-0 items-center justify-center rounded-lg text-white [&>svg]:size-4">
              <Thunderbolt />
            </span>
            <div className="min-w-0 flex-1">
              <p dir="auto" className="truncate text-[13px] font-semibold text-foreground">
                {t('automations.activeRun', { name: activeRun.workflowName })}
              </p>
              <p className="text-xs text-muted">
                {t('automations.run.stepOf', {
                  current: Math.min(activeRun.currentStepIndex + 1, Math.max(runProgress(activeRun).total, 1)),
                  total: runProgress(activeRun).total,
                })}
              </p>
            </div>
            <StatusChip tone={RUN_STATUS_TONE[activeRun.status]} size="sm" pulse={activeRun.status === 'running'} label={t(`run.status.${activeRun.status}`)} />
            <Button size="sm" variant="secondary" onPress={() => navigate({ name: 'automations', workflowId: activeRun.workflowId })}>
              {t('automations.openRun')}
            </Button>
          </div>
        ) : null}

        <ModeNotice />

        {workflows === null ? (
          loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted" role="status">
              <Spinner size="sm" />
              {t('automations.loading')}
            </div>
          ) : (
            <EmptyState
              tone="danger"
              icon={<TriangleExclamation />}
              title={t('automations.loadFailed')}
              description={error}
              actions={
                <Button size="sm" variant="secondary" onPress={onReload}>
                  {t('common.tryAgain')}
                </Button>
              }
            />
          )
        ) : workflows.length === 0 ? (
          <div className="app-panel">
            <EmptyState
              size="lg"
              tone="ai"
              icon={<Thunderbolt />}
              title={t('automations.empty.title')}
              description={t('automations.empty.body')}
              actions={canControl ? actions : null}
            />
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3" aria-label={t('automations.listLabel')}>
            {workflows.map((workflow) => (
              <li key={workflow.id}>
                <WorkflowCard workflow={workflow} running={activeRun?.workflowId === workflow.id} />
              </li>
            ))}
          </ul>
        )}

        <p className="text-center text-[11px] leading-relaxed text-muted">{t('automations.unattended')}</p>
      </div>
    </Page>
  );
}

function WorkflowCard({ workflow, running }: { workflow: Workflow; running: boolean }) {
  const { t } = useI18n();
  const usesAi = workflow.steps.some(stepNeedsAi);
  const status = running ? 'running' : workflow.lastRunStatus;
  return (
    <a
      href={href({ name: 'automations', workflowId: workflow.id })}
      className={[
        'app-panel app-transition flex h-full flex-col gap-3 p-4 outline-none hover:border-hairline-strong hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-focus',
        running ? 'ai-ring' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent [&>svg]:size-4">
          <Thunderbolt />
        </span>
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate text-[14px] font-semibold text-foreground">
            {workflow.name}
          </p>
          <p dir="auto" className="mt-0.5 line-clamp-2 min-h-[2.5em] text-xs leading-relaxed text-muted">
            {workflow.description || t('automations.card.noDescription')}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <SourceBadge source={workflow.source} />
        <StatusChip size="sm" hideDot tone="default" icon={<ListCheck />} label={t('automations.card.steps', { count: workflow.steps.length })} />
        {usesAi ? <StatusChip size="sm" hideDot tone="ai" icon={<Sparkles />} label={t('automations.card.usesAi')} /> : null}
      </div>
      <div className="mt-auto flex items-center gap-2 border-t border-hairline pt-3 text-xs text-muted">
        {status ? (
          <StatusChip size="sm" tone={RUN_STATUS_TONE[status]} pulse={status === 'running'} label={t(`run.status.${status}`)} />
        ) : (
          <span className="flex items-center gap-1.5">
            <CirclePlay className="size-3.5" />
            {t('automations.card.neverRun')}
          </span>
        )}
        <span className="ms-auto truncate text-end">
          {workflow.lastSuccessAt ? (
            <>
              {t('automations.card.lastSuccess')} <RelativeTime at={workflow.lastSuccessAt} />
            </>
          ) : (
            t('automations.card.noSuccess')
          )}
        </span>
      </div>
    </a>
  );
}
