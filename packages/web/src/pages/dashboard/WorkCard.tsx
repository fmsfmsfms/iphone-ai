// Active AI task, active automation run and pending approvals.

import { Smartphone, Sparkles, Thunderbolt } from '@gravity-ui/icons';
import { Button } from '@heroui/react';

import { ApprovalCard, TaskProgress } from '../../components/chat';
import { EmptyState } from '../../components/EmptyState';
import { Panel, Section } from '../../components/Panel';
import { StatusChip } from '../../components/StatusChip';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { useActiveRun, useActiveTask, useApprovals } from '../../state/store';

const MAX_APPROVALS = 3;

export function WorkCard() {
  const { t } = useI18n();
  const task = useActiveTask();
  const run = useActiveRun();
  const approvals = useApprovals();
  const idle = !task && !run && approvals.length === 0;

  return (
    <Panel icon={<Sparkles />} tone={idle ? 'default' : 'ai'} title={t('dashboard.work.title')} description={t('dashboard.work.description')}>
      {idle ? (
        <EmptyState
          size="sm"
          icon={<Sparkles />}
          tone="ai"
          title={t('dashboard.work.idle.title')}
          description={t('dashboard.work.idle.body')}
          actions={
            <>
              <Button size="sm" variant="primary" onPress={() => navigate({ name: 'assistant' })}>
                <Sparkles className="size-3.5" />
                {t('dashboard.work.ask')}
              </Button>
              <Button size="sm" variant="secondary" onPress={() => navigate({ name: 'live' })}>
                <Smartphone className="size-3.5" />
                {t('dashboard.openLive')}
              </Button>
            </>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {task ? (
            <div className="flex flex-col gap-2">
              <TaskProgress task={task} />
              <div>
                <Button size="sm" variant="ghost" onPress={() => navigate({ name: 'assistant', conversationId: task.conversationId })}>
                  {t('dashboard.work.openTask')}
                </Button>
              </div>
            </div>
          ) : null}

          {run ? (
            <div className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface-secondary p-3">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent [&>svg]:size-4">
                <Thunderbolt />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-foreground">{t('dashboard.work.run.title', { name: run.workflowName })}</p>
                <p className="text-xs text-muted">
                  {t('dashboard.work.run.progress', { current: Math.min(run.currentStepIndex + 1, run.steps.length), total: run.steps.length })}
                </p>
              </div>
              <StatusChip tone={run.status === 'running' ? 'ai' : 'warning'} size="sm" pulse={run.status === 'running'} label={t(`run.status.${run.status}`)} />
              <Button size="sm" variant="ghost" onPress={() => navigate({ name: 'automations', workflowId: run.workflowId })}>
                {t('dashboard.work.run.open')}
              </Button>
            </div>
          ) : null}

          {approvals.length > 0 ? (
            <Section title={t('dashboard.work.approvals')}>
              <div className="flex flex-col gap-2.5">
                {approvals.slice(0, MAX_APPROVALS).map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} compact />
                ))}
                {approvals.length > MAX_APPROVALS ? (
                  <p className="text-xs text-muted">{t('dashboard.work.moreApprovals', { count: approvals.length - MAX_APPROVALS })}</p>
                ) : null}
              </div>
            </Section>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
