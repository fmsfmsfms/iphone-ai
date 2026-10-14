// Explains missing macOS permissions and deep-links to System Settings.
// Permissions belong to the "iPhone AI" app (in development: to the app that
// launched the backend, e.g. the terminal).

import { ArrowUpRightFromSquare, ArrowsRotateRight, ShieldExclamation } from '@gravity-ui/icons';
import { Button } from '@heroui/react';
import { useState } from 'react';

import { api, type SettingsPane } from '../lib/api';
import { missingPermissions } from '../lib/device-state';
import { useI18n } from '../lib/i18n';
import { notifyError, refreshConnection, useStatus } from '../state/store';

export interface PermissionBannerProps {
  /** Panes to explain; defaults to whatever the latest status reports as missing. */
  panes?: SettingsPane[];
  compact?: boolean;
  className?: string;
}

const PANE_KEYS: Record<SettingsPane, { title: string; body: string; button: string }> = {
  'screen-recording': {
    title: 'permission.screenRecording.title',
    body: 'permission.screenRecording.body',
    button: 'permission.screenRecording.button',
  },
  accessibility: {
    title: 'permission.accessibility.title',
    body: 'permission.accessibility.body',
    button: 'permission.accessibility.button',
  },
  automation: {
    title: 'permission.automation.title',
    body: 'permission.automation.body',
    button: 'permission.automation.button',
  },
};

export function PermissionBanner({ panes, compact, className }: PermissionBannerProps) {
  const { t } = useI18n();
  const status = useStatus();
  const list = panes ?? missingPermissions(status);
  const [opening, setOpening] = useState<SettingsPane | null>(null);
  const [checking, setChecking] = useState(false);
  if (list.length === 0) return null;

  const open = async (pane: SettingsPane) => {
    setOpening(pane);
    try {
      const res = await api.connection.openSettings(pane);
      if (!res.opened) notifyError(t('permission.openFailed'), new Error(t('permission.openFailedBody')));
    } catch (err) {
      notifyError(t('permission.openFailed'), err);
    } finally {
      setOpening(null);
    }
  };

  const recheck = async () => {
    setChecking(true);
    try {
      await refreshConnection();
    } catch (err) {
      notifyError(t('permission.recheckFailed'), err);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      role="region"
      aria-label={t('permission.region')}
      className={['rounded-2xl border border-warning/25 bg-warning/8 text-start', compact ? 'p-3' : 'p-4', className ?? ''].join(' ')}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning [&>svg]:size-4">
          <ShieldExclamation />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          {list.map((pane) => (
            <div key={pane} className="space-y-1">
              <p className="text-[13px] font-semibold text-foreground">{t(PANE_KEYS[pane].title)}</p>
              {!compact ? <p className="text-xs leading-relaxed text-muted">{t(PANE_KEYS[pane].body)}</p> : null}
              <Button
                size="sm"
                variant="secondary"
                className="mt-1 h-auto min-h-8 max-w-full py-1.5 text-start whitespace-normal"
                isPending={opening === pane}
                onPress={() => void open(pane)}
              >
                <ArrowUpRightFromSquare className="size-3.5 shrink-0" />
                {t(PANE_KEYS[pane].button)}
              </Button>
            </div>
          ))}
          <p className="text-xs leading-relaxed text-muted">{t('permission.ownership')}</p>
          {list.includes('screen-recording') ? (
            <p className="text-xs leading-relaxed text-warning">{t('permission.restartNote')}</p>
          ) : null}
          <Button size="sm" variant="ghost" onPress={() => void recheck()} isPending={checking}>
            <ArrowsRotateRight className="size-3.5" />
            {t('permission.recheck')}
          </Button>
        </div>
      </div>
    </div>
  );
}
