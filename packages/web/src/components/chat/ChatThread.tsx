// Messages of one conversation, merged with live streaming deltas. Sticks to
// the bottom while the user is already at the bottom.

import { Comments } from '@gravity-ui/icons';
import type { ChatMessage } from '@iphone-ai/shared';
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';

import { useI18n } from '../../lib/i18n';
import { useConversationMessages, useStreamingMessages } from '../../state/store';
import { EmptyState } from '../EmptyState';
import { MessageBubble } from './MessageBubble';

export interface ChatThreadProps {
  conversationId: string;
  compact?: boolean;
  /** Replaces the default empty state. */
  empty?: ReactNode;
  /** Extra content after a message, e.g. task progress for `message.taskId`. */
  renderAfterMessage?: (message: ChatMessage) => ReactNode;
  className?: string;
}

interface ThreadItem {
  message: ChatMessage;
  streaming: boolean;
}

const STICK_THRESHOLD_PX = 80;

export function ChatThread({ conversationId, compact, empty, renderAfterMessage, className }: ChatThreadProps) {
  const { t } = useI18n();
  const messages = useConversationMessages(conversationId);
  const streaming = useStreamingMessages(conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const items = useMemo<ThreadItem[]>(() => {
    const byId = new Map(streaming.map((s) => [s.messageId, s]));
    const list: ThreadItem[] = messages.map((message) => {
      const live = byId.get(message.id);
      if (!live) return { message, streaming: Boolean(message.streaming) };
      byId.delete(message.id);
      const text = live.text.length >= message.text.length ? live.text : message.text;
      return { message: { ...message, text }, streaming: true };
    });
    // Deltas that arrived before their chat_message announcement.
    for (const live of byId.values()) {
      list.push({
        message: {
          id: live.messageId,
          conversationId: live.conversationId,
          role: 'assistant',
          text: live.text,
          taskId: null,
          createdAt: live.updatedAt,
          streaming: true,
        },
        streaming: true,
      });
    }
    return list;
  }, [messages, streaming]);

  const lastText = items.length ? items[items.length - 1]!.message.text.length : 0;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = items[items.length - 1];
    if (stickRef.current || last?.message.role === 'user') el.scrollTop = el.scrollHeight;
  }, [items.length, lastText, items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-label={t('chat.threadLabel')}
      aria-live="polite"
      className={['app-scroll flex min-h-0 flex-1 flex-col', compact ? 'gap-3 px-3 py-3' : 'gap-4 px-5 py-5', className ?? ''].join(' ')}
    >
      {items.length === 0
        ? (empty ?? (
            <EmptyState
              size={compact ? 'sm' : 'md'}
              tone="ai"
              icon={<Comments />}
              title={t('chat.empty.title')}
              description={t('chat.empty.body')}
              className="my-auto"
            />
          ))
        : items.map(({ message, streaming: isStreaming }) => (
            <div key={message.id} className="flex flex-col gap-2">
              <MessageBubble
                role={message.role}
                text={message.text}
                createdAt={message.createdAt}
                streaming={isStreaming}
                compact={compact}
              />
              {renderAfterMessage?.(message)}
            </div>
          ))}
    </div>
  );
}
