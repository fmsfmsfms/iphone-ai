// Manual-control switch logic shared by the device panel and the M shortcut:
// enabling asks for confirmation, disabling applies immediately.

import { Hand } from '@gravity-ui/icons';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useI18n } from '../../lib/i18n';
import { notifyError, setManualControl, useAppStore, useCanControl } from '../../state/store';

export function useManualControl() {
  const { t } = useI18n();
  const enabled = useAppStore((s) => s.settings?.permissions.manualControlEnabled ?? false);
  const canControl = useCanControl();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const request = (next: boolean) => {
    if (!canControl || pending) return;
    if (next && !enabled) {
      setConfirming(true);
      return;
    }
    if (!next && enabled) {
      setPending(true);
      setManualControl(false)
        .catch((err: unknown) => notifyError(t('live.manual.error'), err))
        .finally(() => setPending(false));
    }
  };

  const dialog = (
    <ConfirmDialog
      isOpen={confirming}
      onOpenChange={setConfirming}
      title={t('live.manual.confirm.title')}
      confirmLabel={t('live.manual.confirm.button')}
      tone="warning"
      icon={<Hand />}
      onConfirm={() => setManualControl(true)}
    >
      <p>{t('live.manual.confirm.body')}</p>
      <p className="mt-2">{t('live.manual.confirm.body2')}</p>
    </ConfirmDialog>
  );

  return { enabled, canControl, pending, request, toggle: () => request(!enabled), dialog };
}
