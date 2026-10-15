// Right panel of Live Control: a compact chat for the most recent
// conversation (created when none exists). One scroll area holds the whole
// conversation — each AI task inline in its assistant turn, with its pending
// approvals — plus, at the end, anything that needs attention but belongs to
// no message here (an automation's approval, a task from another
// conversation). The cloud privacy notice gates the composer like on the AI
// Assistant page.

import { ArrowUpRightFromSquare, CirclePlus, Sparkles, TriangleExclamation } from '@gravity-ui/icons';
import type { Conversation } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  ApprovalCard,
  ChatThread,
  CloudDisclosureNotice,
  Composer,
  TaskCard,
  useComposerDisabledReason,
  type TaskRenderContext,
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
  useActiveTask,
  useAppStore,
  useApprovals,
  useCanControl,
  useConversationMessages,
} from '../../state/store';

function pickMostRecent(list: Conversation[]): Conversation | null {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

export function AssistantPanel() {
  const { t } = useI18n();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const approvals = useApprovals();
  const activeTask = useActiveTask();
  const canControl = useCanControl();
  const messages = useConversationMessages(conversation?.id);
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

  const send = useCallback(
    async (text: string) => {
      if (!conversation) return;
      try {
        await sendChatMessage(conversation.id, text);
      } catch (err) {
        notifyError(t('live.assistant.sendFailed'), err);
        throw err;
      }
    },
    [conversation, t],
  );

  // Tasks started by a message in this conversation are shown inline (with their approvals).
  const threadTaskIds = useMemo(() => new Set(messages.flatMap((m) => (m.role === 'user' && m.taskId ? [m.taskId] : []))), [messages]);
  const looseTask = activeTask && !threadTaskIds.has(activeTask.id) ? activeTask : null;
  // The pane lists every pending approval (Watchers relies on it): the rest go after the conversation.
  const looseApprovals = approvals.filter((a) => !(a.taskId && (threadTaskIds.has(a.taskId) || a.taskId === looseTask?.id)));

  // Only the newest task offers "Try again": older ones stay quiet.
  const renderTask = useCallback(
    (taskId: string, { hasReply, reply, latest }: TaskRenderContext) => (
      <TaskCard
        taskId={taskId}
        compact
        showSummary={!hasReply}
        reply={reply}
        hideLiveAction
        onRetry={canControl && latest ? send : undefined}
        retryDisabledReason={disabledReason}
      />
    ),
    [canControl, disabledReason, send],
  );

  const elsewhere =
    looseTask || looseApprovals.length > 0 ? (
      <div className="flex flex-col gap-4 border-t border-hairline pt-4">
        {looseApprovals.length > 0 ? (
          <Section title={t('live.assistant.approvals')}>
            <div className="flex flex-col gap-2">
              {looseApprovals.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} compact />
              ))}
            </div>
          </Section>
        ) : null}
        {looseTask ? (
          <Section title={t('live.assistant.task')}>
            <TaskCard taskId={looseTask.id} compact showInstruction showSummary hideLiveAction />
          </Section>
        ) : null}
      </div>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label={t('live.panel.assistant')}>
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-3">
        <span aria-hidden className="ai-gradient-bg flex size-7 shrink-0 items-center justify-center rounded-lg text-white [&>svg]:size-3.5">
          <Sparkles />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[13px] font-semibold text-foreground">{t('live.assistant.title')}</p>
          <p className="truncate text-[11px] text-muted">
            {conversation?.title ? (
              <>
                <bdi>{conversation.title}</bdi>
                {' · '}
              </>
            ) : null}
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
          <ChatThread
            conversationId={conversation.id}
            compact
            renderTask={renderTask}
            footer={elsewhere}
            attention={approvals.length > 0}
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
          <div className="shrink-0 border-t border-hairline p-3">
            <CloudDisclosureNotice compact className="mb-3" />
            <Composer compact onSend={send} disabledReason={disabledReason} placeholder={t('live.assistant.placeholder')} />
          </div>
        </>
      )}
    </div>
  );
}
