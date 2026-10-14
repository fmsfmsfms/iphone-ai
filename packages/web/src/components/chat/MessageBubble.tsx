// One chat message. User messages sit at the end edge (right in LTR, left in
// RTL); assistant messages at the start edge with the AI mark.

import { Sparkles } from '@gravity-ui/icons';
import type { ChatRole } from '@iphone-ai/shared';

import { useI18n } from '../../lib/i18n';
import { RelativeTime } from '../RelativeTime';

export interface MessageBubbleProps {
  role: ChatRole;
  text: string;
  createdAt?: number | null;
  streaming?: boolean;
  compact?: boolean;
}

export function MessageBubble({ role, text, createdAt, streaming, compact }: MessageBubbleProps) {
  const { t } = useI18n();

  if (role === 'system') {
    return (
      <div className="flex justify-center px-2">
        <p dir="auto" className="max-w-[90%] rounded-full bg-default/60 px-3 py-1 text-center text-xs leading-5 text-muted">
          {text}
        </p>
      </div>
    );
  }

  const isUser = role === 'user';
  return (
    <div className={['flex w-full gap-2.5', isUser ? 'justify-end' : 'justify-start'].join(' ')}>
      {!isUser ? (
        <span
          aria-hidden
          className={[
            'ai-gradient-bg mt-0.5 flex shrink-0 items-center justify-center rounded-full text-white',
            compact ? 'size-6 [&>svg]:size-3' : 'size-7 [&>svg]:size-3.5',
          ].join(' ')}
        >
          <Sparkles />
        </span>
      ) : null}
      <div className={['flex max-w-[85%] min-w-0 flex-col gap-1', isUser ? 'items-end' : 'items-start'].join(' ')}>
        <div
          className={[
            'rounded-2xl leading-relaxed break-words whitespace-pre-wrap',
            compact ? 'px-3 py-2 text-[13px]' : 'px-3.5 py-2.5 text-sm',
            isUser
              ? 'rounded-ee-md bg-accent text-accent-foreground'
              : 'rounded-es-md border border-hairline bg-surface-secondary text-foreground',
            streaming ? 'caret-blink' : '',
          ].join(' ')}
          aria-live={streaming ? 'polite' : undefined}
          dir="auto"
        >
          {text || (streaming ? '' : t('chat.emptyMessage'))}
        </div>
        <span className="px-1 text-[11px] text-muted">
          {isUser ? t('chat.you') : t('chat.assistant')}
          {createdAt ? (
            <>
              {' · '}
              <RelativeTime at={createdAt} />
            </>
          ) : null}
          {streaming ? ` · ${t('chat.typing')}` : null}
        </span>
      </div>
    </div>
  );
}
