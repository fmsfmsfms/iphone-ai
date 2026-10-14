// Left column: conversations grouped by last activity, with search, "New
// conversation" (N) and delete (with confirmation).

import { CirclePlus, Comments, TrashBin, TriangleExclamation } from '@gravity-ui/icons';
import type { Conversation } from '@iphone-ai/shared';
import { Button, SearchField, Spinner } from '@heroui/react';
import { useMemo, useState } from 'react';

import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';
import { RelativeTime, useNow } from '../../components/RelativeTime';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { useAppStore, useCanControl } from '../../state/store';
import { filterConversations, groupConversations, isUntitled } from './assistant-utils';

export interface ConversationListProps {
  conversations: Conversation[] | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onNew: () => void;
  onDelete: (conversation: Conversation) => void;
  onReload: () => void;
}

export function ConversationList({ conversations, loading, error, selectedId, onNew, onDelete, onReload }: ConversationListProps) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const now = useNow(60_000);
  const [query, setQuery] = useState('');
  const activeConversationId = useAppStore((s) => (s.activeTaskId ? (s.tasks[s.activeTaskId]?.conversationId ?? null) : null));
  const groups = useMemo(
    () => (conversations ? groupConversations(filterConversations(conversations, query), now) : []),
    [conversations, query, now],
  );

  return (
    <nav aria-label={t('assistant.list.label')} className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 px-4 pt-4 pb-3">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">{t('assistant.list.title')}</h2>
        <IconButton
          label={t('assistant.list.new')}
          icon={<CirclePlus />}
          shortcut={['N']}
          variant="secondary"
          isDisabled={!canControl}
          disabledReason={!canControl ? t('composer.reason.viewOnly') : null}
          onPress={onNew}
          placement="bottom"
        />
      </header>
      {conversations && conversations.length > 0 ? (
        <div className="px-3 pb-2">
          <SearchField value={query} onChange={setQuery} aria-label={t('assistant.list.search')} variant="secondary" className="w-full">
            <SearchField.Group className="h-8">
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t('assistant.list.search')} className="text-[13px]" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
        </div>
      ) : null}

      <div className="app-scroll min-h-0 flex-1 px-2 pb-3">
        {conversations === null ? (
          loading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted" role="status">
              <Spinner size="sm" />
              {t('assistant.list.loading')}
            </div>
          ) : (
            <EmptyState
              size="sm"
              tone="danger"
              icon={<TriangleExclamation />}
              title={t('assistant.list.error')}
              description={error}
              actions={
                <Button size="sm" variant="secondary" onPress={onReload}>
                  {t('common.tryAgain')}
                </Button>
              }
            />
          )
        ) : conversations.length === 0 ? (
          <EmptyState size="sm" icon={<Comments />} title={t('assistant.list.empty.title')} description={t('assistant.list.empty.body')} />
        ) : groups.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">{t('assistant.list.noMatches')}</p>
        ) : (
          groups.map(({ group, items }) => (
            <section key={group} className="mb-2" aria-label={t(`assistant.list.group.${group}`)}>
              <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{t(`assistant.list.group.${group}`)}</h3>
              <ul className="flex flex-col gap-0.5">
                {items.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    selected={conversation.id === selectedId}
                    working={conversation.id === activeConversationId}
                    canDelete={canControl}
                    onDelete={() => onDelete(conversation)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </nav>
  );
}

function ConversationRow({
  conversation,
  selected,
  working,
  canDelete,
  onDelete,
}: {
  conversation: Conversation;
  selected: boolean;
  working: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const title = isUntitled(conversation) ? t('assistant.untitled') : conversation.title;
  return (
    <li className="group relative">
      <a
        href={href({ name: 'assistant', conversationId: conversation.id })}
        aria-current={selected ? 'page' : undefined}
        className={[
          'app-transition flex flex-col gap-0.5 rounded-xl px-3 py-2 pe-10 outline-none focus-visible:ring-2 focus-visible:ring-focus',
          selected ? 'bg-active' : 'hover:bg-hover',
        ].join(' ')}
      >
        <span className="flex items-center gap-2">
          {working ? <span aria-hidden className="status-dot status-dot--pulse shrink-0 text-ai-purple" /> : null}
          <span dir="auto" className={['truncate text-[13px]', selected ? 'font-semibold text-foreground' : 'text-foreground/90'].join(' ')}>
            {title}
          </span>
        </span>
        <span className="text-[11px] text-muted">
          {working ? `${t('assistant.list.working')} · ` : ''}
          <RelativeTime at={conversation.updatedAt} />
        </span>
      </a>
      {canDelete ? (
        <div className="absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton label={t('assistant.list.delete', { title })} icon={<TrashBin />} onPress={onDelete} className="hover:text-danger" />
        </div>
      ) : null}
    </li>
  );
}
