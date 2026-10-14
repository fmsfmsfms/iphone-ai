// Manual-control switch logic shared by the device panel and the M shortcut:
// enabling asks for confirmation, disabling applies immediately. Only the Mac
// may turn it on; a remote device may still turn it off.

import { Hand } from '@gravity-ui/icons';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useI18n } from '../../lib/i18n';
import { notifyError, setManualControl, useAppStore, useCanControl, useIsLocal } from '../../state/store';

export function useManualControl() {
  const { t } = useI18n();
  const enabled = useAppStore((s) => s.settings?.permissions.manualControlEnabled ?? false);
  const canControl = useCanControl();
  const isLocal = useIsLocal();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const request = (next: boolean) => {
    if (!canControl || pending) return;
    if (next && !enabled) {
      if (!isLocal) return; // the backend refuses it from remote devices
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

  /** Turning it on is refused here (view-only, or a remote device while it is off). */
  const cannotTurnOn = !canControl || (!isLocal && !enabled);
  return { enabled, canControl, isLocal, cannotTurnOn, pending, request, toggle: () => request(!enabled), dialog };
}
