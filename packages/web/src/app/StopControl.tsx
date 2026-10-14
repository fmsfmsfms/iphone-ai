// The always-visible emergency stop. While the stop is latched the button
// becomes "Stopped — Re-arm control" and explains exactly what happened.

import { ArrowRotateLeft, OctagonXmark } from '@gravity-ui/icons';
import { Button, Popover, Tooltip } from '@heroui/react';
import { useState } from 'react';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { KbdHint } from '../components/KbdHint';
import { RelativeTime } from '../components/RelativeTime';
import { useI18n } from '../lib/i18n';
import { engageStop, rearmControl, useCanControl, useStopState } from '../state/store';

export function StopControl({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const stop = useStopState();
  const canControl = useCanControl();
  const [pending, setPending] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const press = async () => {
    setPending(true);
    try {
      await engageStop(t('stop.reasonButton'));
    } catch {
      // engageStop already reported the error.
    } finally {
      setPending(false);
    }
  };

  if (!stop.latched) {
    return (
      <Tooltip delay={300}>
        <Button
          aria-label={t('stop.button')}
          aria-keyshortcuts="Meta+Period"
          onPress={() => void press()}
          isPending={pending}
          className={['stop-button h-9 shrink-0 rounded-full font-semibold tracking-wide', compact ? 'px-3' : 'px-4'].join(' ')}
        >
          <OctagonXmark className="size-4" />
          <span className={compact ? 'sr-only' : 'text-[13px]'}>{t('stop.button')}</span>
        </Button>
        <Tooltip.Content placement="bottom end" className="max-w-72 text-xs leading-relaxed">
          <p className="font-medium">{t('stop.tooltip')}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-muted">
            <KbdHint keys={['mod', '.']} />
            {t('common.or')}
            <KbdHint keys={['escape']} />
            <KbdHint keys={['escape']} />
          </p>
        </Tooltip.Content>
      </Tooltip>
    );
  }

  return (
    <>
      <Popover isOpen={popoverOpen} onOpenChange={setPopoverOpen}>
        <Button
          variant="outline"
          className="h-9 shrink-0 rounded-full border-danger/50 bg-danger/10 px-4 text-[13px] font-semibold text-danger"
          aria-label={t('stop.latched.button')}
        >
          <OctagonXmark className="size-4" />
          <span className={compact ? 'sr-only' : ''}>{t('stop.latched.button')}</span>
        </Button>
        <Popover.Content placement="bottom end" className="w-[22rem] max-w-[calc(100vw-2rem)]">
          <Popover.Dialog className="p-4">
            <Popover.Heading className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <OctagonXmark className="size-4 text-danger" />
              {t('stop.latched.title')}
            </Popover.Heading>
            {stop.reason ? (
              <p className="mt-2 text-xs text-muted">
                {t('stop.latched.reason', { reason: stop.reason })}
                {stop.at ? (
                  <>
                    {' · '}
                    <RelativeTime at={stop.at} />
                  </>
                ) : null}
              </p>
            ) : null}
            <ul className="mt-3 space-y-2 text-xs leading-relaxed text-muted">
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" />
                {t('stop.explain.cancelled')}
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" />
                {t('stop.explain.rejected')}
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" />
                {t('stop.explain.sigterm')}
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-warning" />
                <span className="text-foreground/90">{t('stop.explain.irreversible')}</span>
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" />
                {t('stop.explain.physical')}
              </li>
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="tertiary" onPress={() => setPopoverOpen(false)}>
                {t('common.close')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                isDisabled={!canControl}
                onPress={() => {
                  setPopoverOpen(false);
                  setConfirmOpen(true);
                }}
              >
                <ArrowRotateLeft className="size-3.5" />
                {t('stop.rearm.button')}
              </Button>
            </div>
            {!canControl ? <p className="mt-2 text-end text-[11px] text-muted">{t('input.reason.viewOnly')}</p> : null}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <ConfirmDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('stop.rearm.title')}
        confirmLabel={t('stop.rearm.confirm')}
        tone="warning"
        icon={<ArrowRotateLeft />}
        onConfirm={rearmControl}
      >
        <p>{t('stop.rearm.body')}</p>
        <p className="mt-2">{t('stop.rearm.body2')}</p>
      </ConfirmDialog>
    </>
  );
}
