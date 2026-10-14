// A pending approval: what the AI or workflow wants to do, why it needs a
// human decision, and a countdown until it expires (expired = rejected).

import { Check, Clock, ShieldExclamation, Xmark } from '@gravity-ui/icons';
import type { ApprovalRequest } from '@iphone-ai/shared';
import { Button, Input, Label, TextField } from '@heroui/react';
import { useState } from 'react';

import { ApiError } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { decideApproval, notify, notifyError, useCanControl } from '../../state/store';
import { useNow } from '../RelativeTime';
import { StatusChip } from '../StatusChip';
import { formatArgs, RISK_KEY, RISK_TONE } from './task-ui';

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  compact?: boolean;
  className?: string;
}

const RISK_BORDER: Record<ApprovalRequest['risk'], string> = {
  low: 'border-hairline',
  medium: 'border-warning/35',
  high: 'border-danger/45',
};

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function ApprovalCard({ approval, compact, className }: ApprovalCardProps) {
  const { t } = useI18n();
  const now = useNow(1000);
  const canControl = useCanControl();
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [pending, setPending] = useState<'approved' | 'rejected' | null>(null);
  const remaining = approval.expiresAt - now;
  const expired = approval.status !== 'pending' || remaining <= 0;
  const args = formatArgs(approval.action.args);
  const source = approval.workflowRunId ? t('approval.source.workflow') : t('approval.source.ai');

  const decide = async (decision: 'approved' | 'rejected') => {
    setPending(decision);
    try {
      await decideApproval(approval.id, decision, note.trim() || undefined);
    } catch (err) {
      // Already answered elsewhere, expired or cancelled: the card is gone, nothing failed.
      if (err instanceof ApiError && err.code === 'approval_not_pending') notify('info', t('approval.alreadyDecided'));
      else notifyError(t('approval.error'), err);
    } finally {
      setPending(null);
    }
  };

  return (
    <article
      aria-label={t('approval.label')}
      className={[
        'rounded-2xl border bg-surface-secondary',
        RISK_BORDER[approval.risk],
        compact ? 'p-3' : 'p-4',
        className ?? '',
      ].join(' ')}
    >
      <header className="flex items-start gap-3">
        <span
          aria-hidden
          className={[
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4',
            approval.risk === 'high' ? 'bg-danger/15 text-danger' : approval.risk === 'medium' ? 'bg-warning/15 text-warning' : 'bg-default text-muted',
          ].join(' ')}
        >
          <ShieldExclamation />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('approval.title', { source })}</p>
            <StatusChip tone={RISK_TONE[approval.risk]} size="sm" label={t(RISK_KEY[approval.risk])} />
          </div>
          <p dir="auto" className={['mt-1 font-medium text-foreground', compact ? 'text-[13px]' : 'text-sm'].join(' ')}>
            {approval.summary}
          </p>
        </div>
        <span
          className={['flex shrink-0 items-center gap-1 text-xs tabular-nums', expired ? 'text-danger' : remaining < 20_000 ? 'text-warning' : 'text-muted'].join(' ')}
          aria-live="off"
          title={t('approval.expiresHint')}
        >
          <Clock className="size-3.5" />
          {expired ? t('approval.expired') : formatCountdown(remaining)}
        </span>
      </header>

      {approval.reasons.length > 0 ? (
        <ul className="mt-2.5 space-y-1 ps-10 text-xs leading-relaxed text-muted">
          {approval.reasons.map((reason, i) => (
            <li key={i} className="list-disc" dir="auto">
              {reason}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2.5 ms-10 rounded-xl border border-hairline bg-background/60 p-2.5">
        <code className="rounded-md bg-default px-1.5 py-0.5 font-mono text-[11px] text-foreground">{approval.action.tool}</code>
        {args ? (
          <pre className="mt-2 max-h-32 overflow-auto font-mono text-[11px] leading-relaxed text-muted" dir="ltr">
            {args}
          </pre>
        ) : null}
      </div>

      {!expired && canControl ? (
        <div className="mt-3 ms-10 flex flex-col gap-2">
          {showNote ? (
            <TextField value={note} onChange={setNote} aria-label={t('approval.note')} className="w-full">
              <Label className="text-xs text-muted">{t('approval.note')}</Label>
              <Input variant="secondary" placeholder={t('approval.notePlaceholder')} maxLength={500} />
            </TextField>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" isPending={pending === 'approved'} isDisabled={pending !== null} onPress={() => void decide('approved')}>
              <Check className="size-3.5" />
              {t('approval.approve')}
            </Button>
            <Button size="sm" variant="danger" isPending={pending === 'rejected'} isDisabled={pending !== null} onPress={() => void decide('rejected')}>
              <Xmark className="size-3.5" />
              {t('approval.reject')}
            </Button>
            {!showNote ? (
              <Button size="sm" variant="ghost" onPress={() => setShowNote(true)}>
                {t('approval.addNote')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {!expired && !canControl ? <p className="mt-3 ms-10 text-xs text-muted">{t('approval.viewOnly')}</p> : null}
    </article>
  );
}
