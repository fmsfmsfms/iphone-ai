// AI Assistant: conversation list | conversation (chat, task progress and
// steps, approvals, composer). Routes: #/assistant opens the most recent
// conversation (or a fresh start), #/assistant/<id> a specific one.
// Shortcut: N starts a new conversation.

import './messages';

import { TrashBin, TriangleExclamation } from '@gravity-ui/icons';
import type { Conversation } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { api, errorMessage } from '../../lib/api';
import { hasNoModifiers, isTypingTarget, useWindowKeydown } from '../../lib/hotkeys';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { safeStorage } from '../../lib/storage';
import { loadConversation, notify, useAppStore, useCanControl } from '../../state/store';
import { isUntitled, nextConversationAfterRemoval, sortConversations } from './assistant-utils';
import { ConversationList } from './ConversationList';
import { ConversationView } from './ConversationView';

/** Sentinel route for "start a new conversation" (nothing is created until the first instruction). */
const NEW_ID = 'new';

function hasOpenDialog(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

export default function AssistantPage({ conversationId }: { conversationId?: string }) {
  const { t, dir, isRTL } = useI18n();
  const canControl = useCanControl();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // Kept after closing so the dialog's exit animation still shows the right title.
  const [toDelete, setToDelete] = useState<Conversation | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [convState, setConvState] = useState<{ id: string; status: 'loading' | 'ready' | 'error'; error?: string } | null>(null);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `assistant-${dir}`, storage: safeStorage });

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const list = sortConversations(await api.conversations.list());
      setConversations(list);
      setListError(null);
      return list;
    } catch (err) {
      setListError(errorMessage(err));
      return null;
    } finally {
      setListLoading(false);
    }
  }, []);

  // Initial list; #/assistant opens the most recent conversation.
  const routedOnce = useRef(false);
  useEffect(() => {
    void loadList().then((list) => {
      if (routedOnce.current || !list) return;
      routedOnce.current = true;
      if (!conversationId && list[0]) navigate({ name: 'assistant', conversationId: list[0].id }, { replace: true });
    });
    // Only on mount: later route changes are explicit choices.
  }, [loadList]);

  const selectedId = conversationId && conversationId !== NEW_ID ? conversationId : null;
  const selected = selectedId ? (conversations?.find((c) => c.id === selectedId) ?? null) : null;
  const hasCachedMessages = useAppStore((s) => (selectedId ? selectedId in s.messagesByConversation : false));

  // Load messages + tasks of the selected conversation into the store.
  useEffect(() => {
    if (!selectedId) {
      setConvState(null);
      return;
    }
    let cancelled = false;
    setConvState({ id: selectedId, status: 'loading' });
    loadConversation(selectedId)
      .then(() => {
        if (!cancelled) setConvState({ id: selectedId, status: 'ready' });
      })
      .catch((err: unknown) => {
        if (!cancelled) setConvState({ id: selectedId, status: 'error', error: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // A task in this conversation finishing changes its ordering/title: refresh the list.
  const lastTaskEnd = useAppStore((s) => {
    let latest = 0;
    for (const task of Object.values(s.tasks)) if (task.endedAt && task.endedAt > latest) latest = task.endedAt;
    return latest;
  });
  useEffect(() => {
    if (lastTaskEnd > 0) void loadList();
  }, [lastTaskEnd, loadList]);

  const startNew = useCallback(() => {
    navigate({ name: 'assistant', conversationId: NEW_ID });
  }, []);

  useWindowKeydown((e) => {
    if (!hasNoModifiers(e) || e.repeat || isTypingTarget(e.target) || hasOpenDialog()) return;
    if (e.key.toLowerCase() === 'n' && canControl) {
      e.preventDefault();
      startNew();
    }
  });

  const onCreated = (conversation: Conversation) => {
    setConversations((list) => sortConversations([conversation, ...(list ?? []).filter((c) => c.id !== conversation.id)]));
    navigate({ name: 'assistant', conversationId: conversation.id }, { replace: true });
    void loadList();
  };

  const requestDelete = (conversation: Conversation) => {
    setToDelete(conversation);
    setDeleteOpen(true);
  };

  const deleteConversation = async (conversation: Conversation) => {
    await api.conversations.remove(conversation.id);
    const list = conversations ?? [];
    const next = nextConversationAfterRemoval(list, conversation.id);
    setConversations(list.filter((c) => c.id !== conversation.id));
    notify('success', t('assistant.deleted'));
    if (conversation.id === selectedId) {
      navigate(next ? { name: 'assistant', conversationId: next.id } : { name: 'assistant', conversationId: NEW_ID }, { replace: true });
    }
    void loadList();
  };

  let main;
  if (selectedId && convState?.id === selectedId && convState.status === 'error') {
    main = (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          tone="danger"
          icon={<TriangleExclamation />}
          title={t('assistant.loadFailed')}
          description={convState.error}
          actions={
            <>
              <Button size="sm" variant="secondary" onPress={startNew}>
                {t('assistant.newConversation')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onPress={() => {
                  setConvState({ id: selectedId, status: 'loading' });
                  loadConversation(selectedId)
                    .then(() => setConvState({ id: selectedId, status: 'ready' }))
                    .catch((err: unknown) => setConvState({ id: selectedId, status: 'error', error: errorMessage(err) }));
                }}
              >
                {t('common.tryAgain')}
              </Button>
            </>
          }
        />
      </div>
    );
  } else if (selectedId && conversations && !selected && !listLoading) {
    main = (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<TriangleExclamation />}
          title={t('assistant.notFound.title')}
          description={t('assistant.notFound.body')}
          actions={
            <Button size="sm" variant="primary" onPress={startNew}>
              {t('assistant.newConversation')}
            </Button>
          }
        />
      </div>
    );
  } else if (selectedId && (!selected || (convState?.status !== 'ready' && !hasCachedMessages))) {
    main = (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted" role="status">
        <Spinner size="sm" />
        {t('assistant.loadingConversation')}
      </div>
    );
  } else {
    main = (
      <ConversationView
        key={selected?.id ?? NEW_ID}
        conversation={selected}
        onCreated={onCreated}
        onChanged={() => void loadList()}
        onDelete={requestDelete}
      />
    );
  }

  const list = (
    <Panel key="list" id="list" defaultSize="280px" minSize="220px" maxSize="420px" collapsible collapsedSize="0px" className="min-w-0">
      <div dir={dir} className="h-full bg-surface/40">
        <ConversationList
          conversations={conversations}
          loading={listLoading}
          error={listError}
          selectedId={selectedId}
          onNew={startNew}
          onDelete={requestDelete}
          onReload={() => void loadList()}
        />
      </div>
    </Panel>
  );
  const view = (
    <Panel key="view" id="view" minSize="420px" className="min-w-0">
      <div dir={dir} className="h-full">
        {main}
      </div>
    </Panel>
  );
  const sep = <Separator key="sep" className="app-separator" />;

  return (
    <div className="h-full">
      {/* react-resizable-panels has no RTL mode: keep the group LTR and mirror the order instead. */}
      <Group orientation="horizontal" dir="ltr" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} className="h-full">
        {isRTL ? [view, sep, list] : [list, sep, view]}
      </Group>
      <ConfirmDialog
        isOpen={deleteOpen && toDelete !== null}
        onOpenChange={setDeleteOpen}
        tone="danger"
        icon={<TrashBin />}
        title={t('assistant.delete.title', { title: toDelete && !isUntitled(toDelete) ? toDelete.title : t('assistant.untitled') })}
        confirmLabel={t('assistant.delete.confirm')}
        onConfirm={async () => {
          if (toDelete) await deleteConversation(toDelete);
        }}
      >
        {t('assistant.delete.body')}
      </ConfirmDialog>
    </div>
  );
}
