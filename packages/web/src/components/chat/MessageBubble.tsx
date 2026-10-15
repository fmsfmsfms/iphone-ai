// One chat message. User messages sit at the end edge (right in LTR, left in
// RTL); assistant messages at the start edge, marked as the AI's (an avatar
// beside them, or — in compact panels, where width is scarce — a small mark in
// the byline). An assistant turn that ran an AI task shows the task (status,
// steps, approvals) after its reply text, so the newest thing stays at the end.

import { Sparkles } from '@gravity-ui/icons';
import type { ChatRole } from '@iphone-ai/shared';
import type { ReactNode } from 'react';

import { useI18n } from '../../lib/i18n';
import { RelativeTime } from '../RelativeTime';

export interface MessageBubbleProps {
  role: ChatRole;
  text: string;
  createdAt?: number | null;
  streaming?: boolean;
  compact?: boolean;
  /** The AI task this assistant turn ran, shown after the reply (assistant messages only). */
  task?: ReactNode;
}

export function MessageBubble({ role, text, createdAt, streaming, compact, task }: MessageBubbleProps) {
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
  const hasTask = !isUser && Boolean(task);
  // Streamed text ends with the paragraph break before the next turn: keep the caret on the last line.
  const shown = streaming ? text.trimEnd() : text;
  // A task turn without reply text yet (queued, or working before it says anything) shows only the task.
  const showBubble = !hasTask || shown.length > 0;
  const avatar = !isUser && !compact;
  return (
    <div className={['flex w-full', avatar ? 'gap-2.5' : '', isUser ? 'justify-end' : 'justify-start'].join(' ')}>
      {avatar ? (
        <span aria-hidden className="ai-gradient-bg mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-white [&>svg]:size-3.5">
          <Sparkles />
        </span>
      ) : null}
      <div className={['flex min-w-0 flex-1 flex-col gap-1', isUser ? 'items-end' : 'items-start'].join(' ')}>
        {showBubble ? (
          <>
            <div
              className={[
                'min-w-0 rounded-2xl leading-relaxed break-words whitespace-pre-wrap',
                // Compact panels give the AI's text the full width; elsewhere every bubble keeps a readable measure.
                isUser || !compact ? 'max-w-[85%]' : 'max-w-full',
                compact ? 'px-3 py-2 text-[13px]' : 'px-3.5 py-2.5 text-sm',
                isUser
                  ? 'rounded-ee-md bg-accent text-accent-foreground'
                  : 'rounded-es-md border border-hairline bg-surface-secondary text-foreground',
                streaming ? 'caret-blink' : '',
              ].join(' ')}
              aria-live={streaming ? 'polite' : undefined}
              dir="auto"
            >
              {shown || (streaming ? '' : t('chat.emptyMessage'))}
            </div>
            <span className="flex items-center gap-1 px-1 text-[11px] text-muted">
              {!isUser && compact ? (
                <span aria-hidden className="ai-gradient-bg flex size-3.5 shrink-0 items-center justify-center rounded-full text-white [&>svg]:size-2">
                  <Sparkles />
                </span>
              ) : null}
              <span>
                {isUser ? t('chat.you') : t('chat.assistant')}
                {createdAt ? (
                  <>
                    {' · '}
                    <RelativeTime at={createdAt} />
                  </>
                ) : null}
                {streaming ? ` · ${t('chat.typing')}` : null}
              </span>
            </span>
          </>
        ) : null}
        {hasTask ? (
          // Same measure as the bubbles on wide pages; the whole width in compact panels.
          <div className={['w-full min-w-0', compact ? '' : 'max-w-[85%]', showBubble ? 'mt-1.5' : ''].join(' ')}>{task}</div>
        ) : null}
      </div>
    </div>
  );
}
