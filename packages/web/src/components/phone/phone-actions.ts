// Screen-related actions shared by the viewer, the Live Control page and the
// dashboard (with consistent error reporting).

import { useCallback, useState } from 'react';

import type { DeviceAction } from '@iphone-ai/shared';

import { api, ApiError } from '../../lib/api';
import { t } from '../../lib/i18n';
import { captureScreen, notify, notifyError, refreshConnection, restartMcp } from '../../state/store';

/** POST /api/screen/capture with toasts on failure. Returns true on success. */
export async function refreshScreen(options: { resume?: boolean } = {}): Promise<boolean> {
  try {
    await captureScreen(options);
    return true;
  } catch (err) {
    notifyError(options.resume ? t('viewer.resume.failed') : t('viewer.refresh.failed'), err);
    return false;
  }
}

export function useScreenRefresh(): { refresh: (options?: { resume?: boolean }) => Promise<boolean>; refreshing: boolean } {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async (options: { resume?: boolean } = {}) => {
    setRefreshing(true);
    try {
      return await refreshScreen(options);
    } finally {
      setRefreshing(false);
    }
  }, []);
  return { refresh, refreshing };
}

/** Opens Apple's iPhone Mirroring app, then re-reads the connection status. */
export async function openMirroring(): Promise<void> {
  try {
    const res = await api.connection.openMirroring();
    if (!res.opened) {
      notify('warning', t('viewer.openMirroring.notOpened'), t('viewer.openMirroring.notOpenedBody'));
      return;
    }
    notify('info', t('viewer.openMirroring.opened'));
    setTimeout(() => {
      refreshConnection().catch(() => undefined);
    }, 2500);
  } catch (err) {
    notifyError(t('viewer.openMirroring.failed'), err);
  }
}

export async function checkConnection(): Promise<void> {
  try {
    await refreshConnection();
  } catch (err) {
    notifyError(t('viewer.check.failed'), err);
  }
}

export async function restartMirroir(): Promise<void> {
  try {
    await restartMcp();
    notify('success', t('viewer.restart.done'));
  } catch (err) {
    notifyError(t('viewer.restart.failed'), err);
  }
}

/** Codes that mean the touch was computed against an outdated screenshot. */
export const GEOMETRY_ERROR_CODES = new Set(['geometry_changed', 'geometry_unknown', 'out_of_bounds']);

/**
 * Sends a manual device action. Geometry errors trigger a fresh screenshot;
 * everything else becomes an error toast. Returns the ActionResult or null.
 */
export async function sendManualAction(action: DeviceAction, context: { geometryId: string | null; frameSeq: number | null }) {
  try {
    const result = await api.control.action({ action, geometryId: context.geometryId, frameSeq: context.frameSeq });
    if (!result.ok) notify('warning', t('control.actionFailed', { tool: result.tool }), result.message);
    return result;
  } catch (err) {
    if (err instanceof ApiError && GEOMETRY_ERROR_CODES.has(err.code)) {
      notify('warning', t('viewer.touch.geometryChanged'), err.message);
      void refreshScreen();
      return null;
    }
    notifyError(t('control.actionError'), err);
    return null;
  }
}
