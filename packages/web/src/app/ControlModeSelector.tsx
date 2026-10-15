// Current control mode (Observe Only / Assisted / AI Mode). Moving to a
// mode with more AI autonomy asks for confirmation and explains what changes.
// Remote devices may only switch to Observe Only (the backend enforces this).

import { Check, ChevronDown, Eye, Hand, Sparkles } from '@gravity-ui/icons';
import { CONTROL_MODES, type ControlMode } from '@iphone-ai/shared';
import { Button, Popover } from '@heroui/react';
import { useState, type ReactNode } from 'react';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { MODE_LEVEL } from '../lib/device-state';
import { useI18n } from '../lib/i18n';
import { notifyError, setControlMode, useAppStore, useCanControl, useIsLocal } from '../state/store';

export const MODE_ICON: Record<ControlMode, ReactNode> = {
  observe: <Eye />,
  assisted: <Hand />,
  supervised: <Sparkles />,
};

export const MODE_TONE_CLASS: Record<ControlMode, string> = {
  observe: 'bg-default text-foreground',
  assisted: 'bg-accent/15 text-accent',
  supervised: 'ai-gradient-bg text-white',
};

export interface ControlModeSelectorProps {
  /** `toolbar` = compact trigger for the status bar; `inline` = three cards (onboarding). */
  variant?: 'toolbar' | 'inline';
  onChanged?: (mode: ControlMode) => void;
}

/** Whether this session may pick `mode` (remote devices can only go to Observe Only). */
export function modeAllowed(mode: ControlMode, current: ControlMode, isLocal: boolean): boolean {
  return isLocal || mode === 'observe' || mode === current;
}

export function useModeChange(onChanged?: (mode: ControlMode) => void) {
  const current = useAppStore((s) => s.settings?.permissions.controlMode ?? 'observe');
  const isLocal = useIsLocal();
  const [pendingMode, setPendingMode] = useState<ControlMode | null>(null);
  const { t } = useI18n();

  const apply = async (mode: ControlMode) => {
    await setControlMode(mode);
    onChanged?.(mode);
  };

  const request = (mode: ControlMode) => {
    if (mode === current) {
      onChanged?.(mode);
      return;
    }
    // Never open a confirmation the backend would refuse.
    if (!modeAllowed(mode, current, isLocal)) return;
    if (MODE_LEVEL[mode] > MODE_LEVEL[current]) {
      setPendingMode(mode);
      return;
    }
    apply(mode).catch((err: unknown) => notifyError(t('mode.error'), err));
  };

  const dialog = (
    <ConfirmDialog
      isOpen={pendingMode !== null}
      onOpenChange={(open) => !open && setPendingMode(null)}
      title={pendingMode ? t('mode.confirm.title', { mode: t(`mode.${pendingMode}.name`) }) : ''}
      confirmLabel={pendingMode ? t('mode.confirm.button', { mode: t(`mode.${pendingMode}.name`) }) : ''}
      tone={pendingMode === 'supervised' ? 'ai' : 'warning'}
      icon={pendingMode ? MODE_ICON[pendingMode] : null}
      size="md"
      onConfirm={async () => {
        if (pendingMode) await apply(pendingMode);
      }}
    >
      {pendingMode ? (
        <div className="space-y-2.5">
          <p className="text-foreground">{t(`mode.${pendingMode}.confirm`)}</p>
          <ul className="space-y-1.5">
            {[1, 2, 3].map((n) => (
              <li key={n} className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" />
                {t(`mode.${pendingMode}.point${n}`)}
              </li>
            ))}
          </ul>
          <p className="text-xs">{t('mode.confirm.stopHint')}</p>
        </div>
      ) : null}
    </ConfirmDialog>
  );

  return { current, isLocal, request, dialog };
}

function ModeOption({ mode, selected, onSelect, disabled }: { mode: ControlMode; selected: boolean; onSelect: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={[
        'app-transition flex w-full items-start gap-3 rounded-xl p-2.5 text-start outline-none',
        'hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'bg-active' : '',
      ].join(' ')}
    >
      <span aria-hidden className={['mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4', MODE_TONE_CLASS[mode]].join(' ')}>
        {MODE_ICON[mode]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-foreground">{t(`mode.${mode}.name`)}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{t(`mode.${mode}.description`)}</span>
      </span>
      {selected ? <Check className="mt-1 size-4 shrink-0 text-accent" /> : null}
    </button>
  );
}

export function ControlModeSelector({ variant = 'toolbar', onChanged }: ControlModeSelectorProps) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const [open, setOpen] = useState(false);
  const { current, isLocal, request, dialog } = useModeChange(onChanged);
  const disabled = (mode: ControlMode) => !canControl || !modeAllowed(mode, current, isLocal);
  const note = !canControl ? t('input.reason.viewOnly') : !isLocal ? t('mode.localOnly') : null;

  if (variant === 'inline') {
    return (
      <div className="flex flex-col gap-1.5">
        <div role="menu" aria-label={t('mode.label')} className="grid gap-1.5 sm:grid-cols-3">
          {CONTROL_MODES.map((mode) => (
            <div key={mode} className="rounded-xl border border-hairline">
              <ModeOption mode={mode} selected={mode === current} disabled={disabled(mode)} onSelect={() => request(mode)} />
            </div>
          ))}
        </div>
        {canControl && !isLocal ? <p className="text-[11px] text-muted">{note}</p> : null}
        {dialog}
      </div>
    );
  }

  return (
    <>
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button
          variant="tertiary"
          size="sm"
          className="h-9 shrink-0 gap-2 rounded-full border border-hairline bg-surface ps-1.5 pe-3"
          aria-label={t('mode.triggerLabel', { mode: t(`mode.${current}.name`) })}
        >
          <span aria-hidden className={['flex size-6 items-center justify-center rounded-full [&>svg]:size-3.5', MODE_TONE_CLASS[current]].join(' ')}>
            {MODE_ICON[current]}
          </span>
          <span className="hidden flex-col items-start leading-none lg:flex">
            <span className="text-[10px] font-medium tracking-wide text-muted uppercase">{t('mode.label')}</span>
            <span className="text-[13px] font-semibold text-foreground">{t(`mode.${current}.name`)}</span>
          </span>
          <ChevronDown className="size-3.5 text-muted" />
        </Button>
        <Popover.Content placement="bottom end" className="w-[22rem] max-w-[calc(100vw-2rem)]">
          <Popover.Dialog className="p-2">
            <p className="px-2.5 pt-1.5 pb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">{t('mode.label')}</p>
            <div role="menu" aria-label={t('mode.label')} className="flex flex-col gap-0.5">
              {CONTROL_MODES.map((mode) => (
                <ModeOption
                  key={mode}
                  mode={mode}
                  selected={mode === current}
                  disabled={disabled(mode)}
                  onSelect={() => {
                    setOpen(false);
                    request(mode);
                  }}
                />
              ))}
            </div>
            {note ? <p className="px-2.5 pt-2 text-[11px] text-muted">{note}</p> : null}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      {dialog}
    </>
  );
}
