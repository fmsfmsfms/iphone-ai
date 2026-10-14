// Right panel of Live Control: a compact chat for the most recent
// conversation (created when none exists), with pending approvals and the
// current task's progress and latest steps.

import { ArrowUpRightFromSquare, CirclePlus, Sparkles, TriangleExclamation } from '@gravity-ui/icons';
import { TERMINAL_TASK_STATUSES, type AgentTask, type Conversation } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';

import {
  ApprovalCard,
  ChatThread,
  Composer,
  StepTimeline,
  TaskProgress,
  useComposerDisabledReason,
} from '../../components/chat';
import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';
import { Section } from '../../components/Panel';
import { api, errorMessage } from '../../lib/api';
import { t as translateNow, useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import {
  loadConversation,
  notifyError,
  sendChatMessage,
  shallowEqual,
  useActiveTask,
  useAppStore,
  useApprovals,
} from '../../state/store';

function pickMostRecent(list: Conversation[]): Conversation | null {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

function useLatestConversationTask(conversationId: string | null): AgentTask | null {
  return useAppStore(
    (s) => {
      if (!conversationId) return null;
      let latest: AgentTask | null = null;
      for (const task of Object.values(s.tasks)) {
        if (task.conversationId !== conversationId) continue;
        if (!latest || task.createdAt > latest.createdAt) latest = task;
      }
      return latest;
    },
    shallowEqual,
  );
}

export function AssistantPanel() {
  const { t } = useI18n();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const approvals = useApprovals();
  const activeTask = useActiveTask();
  const latestTask = useLatestConversationTask(conversation?.id ?? null);
  const task = activeTask ?? latestTask;
  const disabledReason = useComposerDisabledReason();
  const mode = useAppStore((s) => s.settings?.permissions.controlMode ?? 'observe');

  const open = useCallback(async (conv: Conversation) => {
    setConversation(conv);
    await loadConversation(conv.id);
  }, []);

  const init = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.conversations.list();
      const conv = pickMostRecent(list) ?? (await api.conversations.create(translateNow('live.assistant.newTitle')));
      await open(conv);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    void init();
  }, [init]);

  const startNew = async () => {
    setCreating(true);
    try {
      await open(await api.conversations.create(t('live.assistant.newTitle')));
    } catch (err) {
      notifyError(t('live.assistant.newFailed'), err);
    } finally {
      setCreating(false);
    }
  };

  const send = async (text: string) => {
    if (!conversation) return;
    try {
      await sendChatMessage(conversation.id, text);
    } catch (err) {
      notifyError(t('live.assistant.sendFailed'), err);
      throw err;
    }
  };

  const taskIsTerminal = task ? TERMINAL_TASK_STATUSES.includes(task.status) : false;

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={t('live.panel.assistant')}>
      <header className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <span aria-hidden className="ai-gradient-bg flex size-7 shrink-0 items-center justify-center rounded-lg text-white [&>svg]:size-3.5">
          <Sparkles />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[13px] font-semibold text-foreground">{t('live.assistant.title')}</p>
          <p className="truncate text-[11px] text-muted">
            {conversation?.title ? `${conversation.title} · ` : ''}
            {t('live.assistant.mode', { mode: t(`mode.${mode}.name`) })}
          </p>
        </div>
        <IconButton
          label={t('live.assistant.newConversation')}
          icon={<CirclePlus />}
          onPress={() => void startNew()}
          isPending={creating}
          isDisabled={loading}
        />
        <IconButton
          label={t('live.assistant.openFull')}
          icon={<ArrowUpRightFromSquare />}
          isDisabled={!conversation}
          onPress={() => conversation && navigate({ name: 'assistant', conversationId: conversation.id })}
        />
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted" role="status">
          <Spinner size="sm" />
          {t('live.assistant.loading')}
        </div>
      ) : error || !conversation ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            size="sm"
            tone="danger"
            icon={<TriangleExclamation />}
            title={t('live.assistant.error')}
            description={error}
            actions={
              <Button size="sm" variant="secondary" onPress={() => void init()}>
                {t('live.assistant.retry')}
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {approvals.length > 0 || task ? (
            <div className="app-scroll flex max-h-[55%] shrink-0 flex-col gap-4 border-b border-hairline p-3">
              {approvals.length > 0 ? (
                <Section title={t('live.assistant.approvals')}>
                  <div className="flex flex-col gap-2">
                    {approvals.map((approval) => (
                      <ApprovalCard key={approval.id} approval={approval} compact />
                    ))}
                  </div>
                </Section>
              ) : null}
              {task ? (
                <Section title={taskIsTerminal ? t('live.assistant.lastTask') : t('live.assistant.task')}>
                  <TaskProgress task={task} compact />
                  <StepTimeline taskId={task.id} compact limit={5} className="mt-1" />
                </Section>
              ) : null}
            </div>
          ) : null}
          <ChatThread
            conversationId={conversation.id}
            compact
            empty={
              <EmptyState
                size="sm"
                tone="ai"
                icon={<Sparkles />}
                title={t('live.assistant.empty.title')}
                description={t('live.assistant.empty.body')}
                className="my-auto"
              />
            }
          />
          <div className="border-t border-hairline p-3">
            <Composer compact onSend={send} disabledReason={disabledReason} placeholder={t('live.assistant.placeholder')} />
          </div>
        </>
      )}
    </div>
  );
}
