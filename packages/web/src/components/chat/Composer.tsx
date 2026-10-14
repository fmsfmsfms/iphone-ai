// Multiline instruction box. ⌘↵ (Ctrl+Enter elsewhere) sends. When sending is
// not possible the box is disabled and says why.

import { ArrowUp, CircleInfo } from '@gravity-ui/icons';
import { Button, TextArea } from '@heroui/react';
import { useRef, useState, type KeyboardEvent } from 'react';

import { useI18n } from '../../lib/i18n';
import { KbdHint } from '../KbdHint';

export interface ComposerProps {
  onSend: (text: string) => Promise<unknown> | void;
  /** Translated explanation; when set the composer is disabled. */
  disabledReason?: string | null;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  className?: string;
}

export function Composer({ onSend, disabledReason, placeholder, compact, autoFocus, maxLength = 4000, className }: ComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const disabled = Boolean(disabledReason);
  const trimmed = text.trim();
  const canSend = !disabled && !sending && trimmed.length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setText('');
    } catch {
      // The caller reports the error; keep the draft so nothing is lost.
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className={['flex flex-col gap-1.5', className ?? ''].join(' ')}>
      <div
        className={[
          'app-transition flex items-end gap-2 rounded-2xl border bg-surface-secondary p-1.5 ps-3',
          disabled ? 'border-hairline opacity-70' : 'border-hairline focus-within:border-accent/60',
        ].join(' ')}
      >
        <TextArea
          ref={ref}
          aria-label={t('composer.label')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? t('composer.placeholder')}
          disabled={disabled}
          rows={compact ? 2 : 3}
          maxLength={maxLength}
          autoFocus={autoFocus}
          variant="secondary"
          className="max-h-48 min-h-0 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 text-sm shadow-none outline-none focus:ring-0"
        />
        <Button
          isIconOnly
          aria-label={t('composer.send')}
          variant="primary"
          size="sm"
          className="ai-gradient-bg mb-0.5 shrink-0 rounded-xl text-white"
          isDisabled={!canSend}
          isPending={sending}
          onPress={() => void send()}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-5 items-center gap-2 px-1 text-[11px] text-muted">
        {disabled ? (
          <span className="flex items-center gap-1.5 text-warning">
            <CircleInfo className="size-3.5 shrink-0" />
            {disabledReason}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <KbdHint keys={['mod', 'enter']} />
            {t('composer.sendHint')}
          </span>
        )}
      </div>
    </div>
  );
}
