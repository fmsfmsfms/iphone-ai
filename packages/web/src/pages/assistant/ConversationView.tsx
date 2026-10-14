// Right column: one conversation — header (title, provider/model, control
// mode), the chat with each task's progress and steps, the cloud privacy
// notice and the composer (disabled with a reason when sending isn't possible).

import { ArrowUpRightFromSquare, BroomMotion, ChevronDown, Comments, EllipsisVertical, Eye, Gear, Hand, Smartphone, Sparkles, TrashBin } from '@gravity-ui/icons';
import type { ChatMessage, Conversation } from '@iphone-ai/shared';
import { Button, Dropdown, Label } from '@heroui/react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import { MODE_ICON, useModeChange } from '../../app/ControlModeSelector';
import { ChatThread, CloudDisclosureNotice, Composer } from '../../components/chat';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { StatusChip } from '../../components/StatusChip';
import { api } from '../../lib/api';
import { providerReadiness } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import {
  notifyError,
  replaceMessages,
  sendChatMessage,
  useActiveTask,
  useAppStore,
  useCanControl,
  useConversationMessages,
  useIsLocal,
} from '../../state/store';
import { assistantBlockReason, EXAMPLE_PROMPT_KEYS, isUntitled, needsCloudDisclosure, reasonText, type Reason } from './assistant-utils';
import { ProviderPicker } from './ProviderPicker';
import { TaskBlock } from './TaskBlock';

export interface ConversationViewProps {
  /** null = no conversation yet; the first instruction creates one. */
  conversation: Conversation | null;
  /** A conversation was created by sending the first instruction. */
  onCreated: (conversation: Conversation) => void;
  /** Messages changed (title / ordering in the list may have changed). */
  onChanged: () => void;
  onDelete: (conversation: Conversation) => void;
}

const MODE_TONE = { observe: 'default', assisted: 'accent', supervised: 'ai' } as const;

export function ConversationView({ conversation, onCreated, onChanged, onDelete }: ConversationViewProps) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const settings = useAppStore((s) => s.settings);
  const session = useAppStore((s) => s.session);
  const status = useAppStore((s) => s.status);
  const stopLatched = useAppStore((s) => s.stop.latched);
  const connected = useAppStore((s) => s.connection.socket === 'open');
  const activeTask = useActiveTask();
  const messages = useConversationMessages(conversation?.id);
  const mode = settings?.permissions.controlMode ?? 'observe';
  const provider = providerReadiness(settings).provider;
  const disclosure = needsCloudDisclosure(settings, provider);
  const [confirmClear, setConfirmClear] = useState(false);
  /** Conversation created by a send that then failed; reused for the next attempt. */
  const pendingCreated = useRef<Conversation | null>(null);

  const blockReason: Reason | null =
    assistantBlockReason({ settings, session, status, stopLatched, activeTask, connected, conversationId: conversation?.id ?? null }) ??
    (disclosure ? { key: 'assistant.reason.disclosure' } : null);
  const blockText = blockReason ? reasonText(blockReason, t) : null;

  const latestTaskId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role === 'user' && m.taskId) return m.taskId;
    }
    return null;
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      try {
        if (conversation) {
          await sendChatMessage(conversation.id, text);
          onChanged();
          return;
        }
        const created = pendingCreated.current ?? (await api.conversations.create());
        pendingCreated.current = created;
        await sendChatMessage(created.id, text);
        pendingCreated.current = null;
        onCreated(created);
      } catch (err) {
        notifyError(t('assistant.sendFailed'), err);
        if (pendingCreated.current) onChanged();
        throw err;
      }
    },
    [conversation, onChanged, onCreated, t],
  );

  const renderAfterMessage = useCallback(
    (message: ChatMessage) =>
      message.role === 'user' && message.taskId ? (
        <TaskBlock
          taskId={message.taskId}
          defaultExpanded={message.taskId === latestTaskId}
          onRetry={canControl ? (instruction) => send(instruction) : undefined}
          retryDisabledReason={blockText}
        />
      ) : null,
    [blockText, canControl, latestTaskId, send],
  );

  const title = conversation && !isUntitled(conversation) ? conversation.title : t('assistant.untitled');
  const examplesDisabled = Boolean(blockReason);

  return (
    <section aria-label={t('assistant.view.label')} className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-5 py-3">
        <div className="min-w-[14rem] flex-1">
          <h1 dir="auto" className="truncate text-[17px] leading-7 font-semibold tracking-tight text-foreground">
            {conversation ? title : t('assistant.newConversation')}
          </h1>
          <p className="truncate text-xs text-muted">{t('assistant.view.subtitle')}</p>
        </div>
        <ProviderPicker />
        <StatusChip
          tone={MODE_TONE[mode]}
          hideDot
          icon={MODE_ICON[mode]}
          label={t(`mode.${mode}.name`)}
          tooltip={t(`mode.${mode}.description`)}
        />
        {conversation ? (
          <Dropdown>
            <Button isIconOnly size="sm" variant="ghost" aria-label={t('assistant.view.more')}>
              <EllipsisVertical className="size-4" />
            </Button>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={t('assistant.view.more')}
                disabledKeys={!canControl ? ['clear', 'delete'] : messages.length === 0 ? ['clear'] : []}
                onAction={(key) => {
                  if (key === 'clear') setConfirmClear(true);
                  else if (key === 'delete') onDelete(conversation);
                  else if (key === 'live') navigate({ name: 'live' });
                }}
              >
                <Dropdown.Item id="live" textValue={t('assistant.view.openLive')}>
                  <Smartphone className="size-4 text-muted" />
                  <Label>{t('assistant.view.openLive')}</Label>
                </Dropdown.Item>
                <Dropdown.Item id="clear" textValue={t('assistant.view.clear')}>
                  <BroomMotion className="size-4 text-muted" />
                  <Label>{t('assistant.view.clear')}</Label>
                </Dropdown.Item>
                <Dropdown.Item id="delete" textValue={t('assistant.view.delete')} variant="danger">
                  <TrashBin className="size-4 text-danger" />
                  <Label>{t('assistant.view.delete')}</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : null}
      </header>

      {mode === 'observe' ? <ObserveHint /> : null}

      {conversation ? (
        <ChatThread
          conversationId={conversation.id}
          renderAfterMessage={renderAfterMessage}
          className="px-[max(1.25rem,calc((100%-50rem)/2))]"
          empty={<Welcome onPick={(text) => void send(text).catch(() => undefined)} disabled={examplesDisabled} />}
        />
      ) : (
        <div className="app-scroll flex min-h-0 flex-1 flex-col px-[max(1.25rem,calc((100%-50rem)/2))] py-5">
          <Welcome onPick={(text) => void send(text).catch(() => undefined)} disabled={examplesDisabled} />
        </div>
      )}

      <footer className="border-t border-hairline px-[max(1.25rem,calc((100%-50rem)/2))] pt-3 pb-4">
        <CloudDisclosureNotice className="mb-3" />
        {blockReason?.action ? <ReasonAction reason={blockReason} taskConversationId={activeTask?.conversationId ?? null} /> : null}
        <Composer onSend={send} disabledReason={blockText} placeholder={t('assistant.placeholder')} autoFocus={!blockText} />
      </footer>

      {conversation ? (
        <ConfirmDialog
          isOpen={confirmClear}
          onOpenChange={setConfirmClear}
          tone="warning"
          icon={<BroomMotion />}
          title={t('assistant.clear.title')}
          confirmLabel={t('assistant.clear.confirm')}
          onConfirm={async () => {
            await api.conversations.clear(conversation.id);
            replaceMessages(conversation.id, []);
            onChanged();
          }}
        >
          {t('assistant.clear.body')}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function ObserveHint() {
  const { t } = useI18n();
  const canControl = useCanControl();
  const isLocal = useIsLocal();
  const { request, dialog } = useModeChange();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline bg-surface/60 px-5 py-2 text-xs text-muted">
      <Eye className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">{t('mode.observe.name')}</span>
        {' — '}
        {t('assistant.observeHint')}
      </span>
      {canControl && !isLocal ? <span className="text-[11px] text-muted">{t('mode.localOnly')}</span> : null}
      {canControl && isLocal ? (
        <Dropdown>
          <Button size="sm" variant="ghost" className="h-7">
            {t('assistant.changeMode')}
            <ChevronDown className="size-3.5" />
          </Button>
          <Dropdown.Popover placement="bottom end" className="w-[20rem]">
            <Dropdown.Menu aria-label={t('mode.label')} onAction={(key) => (key === 'assisted' || key === 'supervised') && request(key)}>
              <Dropdown.Item id="assisted" textValue={t('mode.assisted.name')} className="items-start">
                <Hand className="mt-0.5 size-4 shrink-0 text-accent" />
                <div className="flex flex-col">
                  <Label>{t('mode.assisted.name')}</Label>
                  <span className="text-[11px] leading-snug whitespace-normal text-muted">{t('mode.assisted.description')}</span>
                </div>
              </Dropdown.Item>
              <Dropdown.Item id="supervised" textValue={t('mode.supervised.name')} className="items-start">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-ai-purple" />
                <div className="flex flex-col">
                  <Label>{t('mode.supervised.name')}</Label>
                  <span className="text-[11px] leading-snug whitespace-normal text-muted">{t('mode.supervised.description')}</span>
                </div>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
      {dialog}
    </div>
  );
}

function Welcome({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  const { t } = useI18n();
  return (
    <div className="my-auto flex flex-col items-center gap-5 py-8 text-center">
      <span aria-hidden className="ai-gradient-bg flex size-12 items-center justify-center rounded-2xl text-white [&>svg]:size-6">
        <Sparkles />
      </span>
      <div className="max-w-lg">
        <h2 className="text-lg font-semibold text-foreground">{t('assistant.welcome.title')}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{t('assistant.welcome.body')}</p>
      </div>
      <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-2" role="group" aria-label={t('assistant.welcome.examples')}>
        {EXAMPLE_PROMPT_KEYS.map((key) => {
          const text = t(key);
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onPick(text)}
              title={t('assistant.welcome.exampleHint')}
              className="app-transition flex items-center gap-2.5 rounded-xl border border-hairline bg-surface-secondary/70 px-3.5 py-2.5 text-start text-[13px] text-foreground outline-none hover:border-hairline-strong hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Comments className="size-3.5 shrink-0 text-ai-purple" />
              <span className="min-w-0 flex-1">{text}</span>
            </button>
          );
        })}
      </div>
      <p className="max-w-lg text-[11px] leading-relaxed text-muted">{t('assistant.welcome.safety')}</p>
    </div>
  );
}

function ReasonAction({ reason, taskConversationId }: { reason: Reason; taskConversationId: string | null }) {
  const { t } = useI18n();
  let button: { label: string; onPress: () => void; icon: ReactNode } | null = null;
  switch (reason.action) {
    case 'settings-ai':
      button = { label: t('assistant.action.setUpProvider'), onPress: () => navigate({ name: 'settings', section: 'ai' }), icon: <Gear className="size-3.5" /> };
      break;
    case 'live':
      button = { label: t('assistant.action.openLive'), onPress: () => navigate({ name: 'live' }), icon: <Smartphone className="size-3.5" /> };
      break;
    case 'dashboard':
      button = { label: t('assistant.action.checkConnection'), onPress: () => navigate({ name: 'dashboard' }), icon: <ArrowUpRightFromSquare className="size-3.5" /> };
      break;
    case 'open-task':
      if (taskConversationId) {
        button = {
          label: t('assistant.action.openTask'),
          onPress: () => navigate({ name: 'assistant', conversationId: taskConversationId }),
          icon: <ArrowUpRightFromSquare className="size-3.5" />,
        };
      }
      break;
    default:
      break;
  }
  if (!button) return null;
  return (
    <div className="mb-2 flex justify-end">
      <Button size="sm" variant="secondary" onPress={button.onPress}>
        {button.icon}
        {button.label}
      </Button>
    </div>
  );
}
