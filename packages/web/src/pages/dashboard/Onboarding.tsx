// Setup checklist. Each item reflects live status and offers the next step.

import {
  ArrowUpRightFromSquare,
  ArrowsRotateRight,
  CircleCheckFill,
  CirclePlay,
  Gear,
  ListCheck,
} from '@gravity-ui/icons';
import { Button, Spinner } from '@heroui/react';
import { useEffect, useState, type ReactNode } from 'react';

import { ControlModeSelector } from '../../app/ControlModeSelector';
import { Panel } from '../../components/Panel';
import { checkConnection, openMirroring, refreshScreen, restartMirroir } from '../../components/phone/phone-actions';
import { api, type ClaudeCodeStatus, type SettingsPane } from '../../lib/api';
import { providerReadiness } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { notifyError, updateSettings, useAppStore, useCanControl, useIsLocal } from '../../state/store';

export interface OnboardingItem {
  id: string;
  title: string;
  detail: ReactNode;
  done: boolean;
  busy?: boolean;
  action?: ReactNode;
}

function useClaudeCodeStatus(enabled: boolean): ClaudeCodeStatus | null {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.providers
      .claudeCodeStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? status : null;
}

export function useOnboardingItems(): { items: OnboardingItem[]; loading: boolean } {
  const { t } = useI18n();
  const status = useAppStore((s) => s.status);
  const settings = useAppStore((s) => s.settings);
  const canControl = useCanControl();
  const isLocal = useIsLocal();
  const [busy, setBusy] = useState<string | null>(null);
  const readiness = providerReadiness(settings);
  const claudeCode = useClaudeCodeStatus(readiness.provider?.kind === 'claude-agent-sdk');

  if (!status || !settings) return { items: [], loading: true };

  const run = (id: string, fn: () => Promise<unknown>) => async () => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const openPane = (pane: SettingsPane) =>
    run(pane, async () => {
      try {
        await api.connection.openSettings(pane);
      } catch (err) {
        notifyError(t('permission.openFailed'), err);
      }
    });

  const button = (id: string, label: string, icon: ReactNode, onPress: () => void, variant: 'primary' | 'secondary' = 'secondary') => (
    <Button size="sm" variant={variant} isPending={busy === id} isDisabled={!canControl} onPress={onPress}>
      {icon}
      {label}
    </Button>
  );

  // System Settings can only be opened on the Mac (the backend refuses it from remote devices).
  const paneButton = (id: string, pane: SettingsPane) =>
    isLocal ? (
      button(id, t('dashboard.onboarding.openSettings'), <ArrowUpRightFromSquare className="size-3.5" />, openPane(pane))
    ) : (
      <span className="text-xs text-muted">{t('permission.localOnly')}</span>
    );

  const server = status.server;
  const mcpDetail =
    server.state === 'ready'
      ? t('dashboard.onboarding.mcp.done', { tools: server.tools.length })
      : server.state === 'binary_missing'
        ? t('dashboard.onboarding.mcp.missing', { path: server.binaryPath })
        : server.state === 'crashed'
          ? t('dashboard.onboarding.mcp.crashed')
          : server.state === 'stopped'
            ? t('dashboard.onboarding.mcp.stopped')
            : t('dashboard.onboarding.mcp.starting');
  const mcpAction =
    server.state === 'binary_missing' ? (
      <Button size="sm" variant="secondary" onPress={() => navigate({ name: 'settings', section: 'connection' })}>
        <Gear className="size-3.5" />
        {t('dashboard.onboarding.mcp.settings')}
      </Button>
    ) : server.state === 'crashed' || server.state === 'stopped' ? (
      button('mcp', t('dashboard.onboarding.mcp.restart'), <ArrowsRotateRight className="size-3.5" />, run('mcp', restartMirroir))
    ) : null;

  const mirroring = status.mirroring.state;
  const mirroringDetail =
    mirroring === 'connected'
      ? t('dashboard.onboarding.mirroring.done')
      : mirroring === 'paused'
        ? t('dashboard.onboarding.mirroring.paused')
        : mirroring === 'no_window'
          ? t('dashboard.onboarding.mirroring.noWindow')
          : mirroring === 'not_running'
            ? t('dashboard.onboarding.mirroring.notRunning')
            : t('dashboard.onboarding.mirroring.unknown');
  const mirroringAction =
    mirroring === 'not_running' || mirroring === 'error'
      ? button('mirroring', t('viewer.openMirroring'), <ArrowUpRightFromSquare className="size-3.5" />, run('mirroring', openMirroring), 'primary')
      : mirroring === 'paused'
        ? button('mirroring', t('dashboard.onboarding.mirroring.resume'), <CirclePlay className="size-3.5" />, run('mirroring', () => refreshScreen({ resume: true })))
        : mirroring === 'no_window'
          ? paneButton('mirroring', 'accessibility')
          : mirroring === 'unknown'
            ? button('mirroring', t('viewer.checkNow'), <ArrowsRotateRight className="size-3.5" />, run('mirroring', checkConnection))
            : null;

  const sr = status.permissions.screenRecording === 'granted';
  const ax = status.permissions.accessibility === 'granted';

  const claudeLoggedOut = readiness.provider?.kind === 'claude-agent-sdk' && claudeCode !== null && (!claudeCode.available || !claudeCode.loggedIn);
  const providerDone = readiness.configured && !claudeLoggedOut;
  const providerDetail = providerDone
    ? t('dashboard.onboarding.provider.done', { provider: readiness.provider?.label ?? '' })
    : claudeLoggedOut
      ? claudeCode?.detail || t('dashboard.onboarding.provider.claudeCodeLoggedOut')
      : `${t(readiness.reasonKey ?? 'provider.reason.none')} ${t('dashboard.onboarding.provider.todo')}`;

  const mode = settings.permissions.controlMode;
  const modeDone = settings.general.onboardingCompleted;

  const items: OnboardingItem[] = [
    { id: 'mcp', title: t('dashboard.onboarding.mcp.title'), detail: mcpDetail, done: server.state === 'ready', busy: server.state === 'starting' || server.state === 'restarting', action: mcpAction },
    { id: 'mirroring', title: t('dashboard.onboarding.mirroring.title'), detail: mirroringDetail, done: mirroring === 'connected', busy: mirroring === 'unknown', action: mirroringAction },
    {
      id: 'screen-recording',
      title: t('dashboard.onboarding.screenRecording.title'),
      detail: sr ? t('dashboard.onboarding.screenRecording.done') : t('dashboard.onboarding.screenRecording.todo'),
      done: sr,
      action: sr ? null : paneButton('screen-recording', 'screen-recording'),
    },
    {
      id: 'accessibility',
      title: t('dashboard.onboarding.accessibility.title'),
      detail: ax ? t('dashboard.onboarding.accessibility.done') : t('dashboard.onboarding.accessibility.todo'),
      done: ax,
      action: ax ? null : paneButton('accessibility', 'accessibility'),
    },
    {
      id: 'provider',
      title: t('dashboard.onboarding.provider.title'),
      detail: providerDetail,
      done: providerDone,
      action: providerDone ? null : (
        <Button size="sm" variant="secondary" onPress={() => navigate({ name: 'settings', section: 'ai' })}>
          <Gear className="size-3.5" />
          {t('dashboard.onboarding.provider.action')}
        </Button>
      ),
    },
    {
      id: 'mode',
      title: t('dashboard.onboarding.mode.title'),
      detail: modeDone ? t('dashboard.onboarding.mode.done', { mode: t(`mode.${mode}.name`) }) : t('dashboard.onboarding.mode.todo'),
      done: modeDone,
      action: modeDone ? null : (
        <div className="flex w-full flex-col gap-2">
          <ControlModeSelector variant="inline" />
          <div>
            {button(
              'mode',
              t('dashboard.onboarding.mode.keep', { mode: t(`mode.${mode}.name`) }),
              <CircleCheckFill className="size-3.5" />,
              run('mode', async () => {
                try {
                  await updateSettings({ general: { onboardingCompleted: true } });
                } catch (err) {
                  notifyError(t('common.saveFailed'), err);
                }
              }),
              'primary',
            )}
          </div>
        </div>
      ),
    },
  ];
  return { items, loading: false };
}

export function OnboardingChecklist({ items }: { items: OnboardingItem[] }) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return null;
  const firstOpen = items.find((i) => !i.done)?.id;

  return (
    <Panel
      icon={<ListCheck />}
      title={t('dashboard.onboarding.title')}
      description={t('dashboard.onboarding.description')}
      actions={<span className="text-xs text-muted tabular-nums">{t('dashboard.onboarding.progress', { done, total: items.length })}</span>}
      tone="ai"
    >
      <div className="mb-4 h-1 overflow-hidden rounded-full bg-default" aria-hidden>
        <div className="ai-gradient-bg h-full rounded-full transition-[width] duration-200" style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      <ol className="flex flex-col divide-y divide-hairline">
        {items.map((item, index) => (
          <li key={item.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <span
              aria-hidden
              className={[
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                item.done ? 'bg-success/15 text-success' : item.id === firstOpen ? 'bg-accent/15 text-accent' : 'bg-default text-muted',
              ].join(' ')}
            >
              {item.done ? <CircleCheckFill className="size-4" /> : item.busy ? <Spinner size="sm" /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={['text-[13px] font-semibold', item.done ? 'text-muted' : 'text-foreground'].join(' ')}>
                <span className="sr-only">{item.done ? t('common.done') : t('common.todo')}: </span>
                {item.title}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{item.detail}</p>
              {!item.done && item.action ? <div className="mt-2 flex flex-wrap gap-2">{item.action}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
