// What the viewer shows instead of (or over) the screenshot when it cannot
// show a live picture, with the next step for each case.

import {
  ArrowUpRightFromSquare,
  ArrowsRotateRight,
  CirclePlay,
  Gear,
  PlugConnection,
  ShieldExclamation,
  Smartphone,
  TriangleExclamation,
} from '@gravity-ui/icons';
import type { DeviceStatus, StreamStats } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useState, type ReactNode } from 'react';

import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { PermissionBanner } from '../PermissionBanner';
import { checkConnection, openMirroring, restartMirroir, useScreenRefresh } from './phone-actions';

export type ViewerBlock =
  | { kind: 'loading' }
  | { kind: 'mcp'; state: DeviceStatus['server']['state']; binaryPath: string; lastError: string | null }
  | { kind: 'not_running' }
  | { kind: 'no_window'; accessibilityGranted: boolean }
  | { kind: 'paused' }
  | { kind: 'screen_recording' }
  | { kind: 'unknown'; rawStatus: string; error: boolean }
  | { kind: 'waiting'; pausedReason: string | null };

/** Decides whether the viewer can show frames, and if not, why (pure). */
export function viewerBlock(status: DeviceStatus | null, stream: StreamStats | null, hasFrame: boolean): ViewerBlock | null {
  if (!status) return { kind: 'loading' };
  if (status.server.state !== 'ready') {
    return { kind: 'mcp', state: status.server.state, binaryPath: status.server.binaryPath, lastError: status.server.lastError };
  }
  switch (status.mirroring.state) {
    case 'not_running':
      return { kind: 'not_running' };
    case 'no_window':
      return { kind: 'no_window', accessibilityGranted: status.permissions.accessibility === 'granted' };
    case 'paused':
      return { kind: 'paused' };
    case 'unknown':
    case 'error':
      return { kind: 'unknown', rawStatus: status.mirroring.rawStatus, error: status.mirroring.state === 'error' };
    case 'connected':
      break;
  }
  if (status.permissions.screenRecording !== 'granted') return { kind: 'screen_recording' };
  if (!hasFrame) return { kind: 'waiting', pausedReason: stream?.pausedReason ?? null };
  return null;
}

interface OverlayProps {
  block: ViewerBlock;
  compact?: boolean;
  canControl: boolean;
}

function Shell({
  icon,
  tone = 'default',
  title,
  body,
  children,
  compact,
}: {
  icon: ReactNode;
  tone?: 'default' | 'warning' | 'danger';
  title: string;
  body?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
}) {
  const toneClass = tone === 'danger' ? 'bg-danger/15 text-danger' : tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-white/10 text-white/80';
  return (
    <div className={['flex h-full w-full flex-col items-center justify-center text-center', compact ? 'gap-2 p-3' : 'gap-3 p-5'].join(' ')}>
      <span aria-hidden className={['flex items-center justify-center rounded-2xl', compact ? 'size-9 [&>svg]:size-4' : 'size-12 [&>svg]:size-5', toneClass].join(' ')}>
        {icon}
      </span>
      <p className={['font-semibold text-white', compact ? 'text-[13px]' : 'text-[15px]'].join(' ')}>{title}</p>
      {body ? <div className={['max-w-xs leading-relaxed text-white/65', compact ? 'text-[11px]' : 'text-xs'].join(' ')}>{body}</div> : null}
      {children ? <div className="flex w-full max-w-xs flex-col items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function ViewerOverlay({ block, compact, canControl }: OverlayProps) {
  const { t } = useI18n();
  const { refresh, refreshing } = useScreenRefresh();
  const [busy, setBusy] = useState<string | null>(null);
  const size = compact ? 'sm' : 'md';

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  switch (block.kind) {
    case 'loading':
      return (
        <Shell compact={compact} icon={<Spinner size="sm" />} title={t('viewer.block.loading.title')} />
      );

    case 'mcp': {
      if (block.state === 'starting' || block.state === 'restarting') {
        return <Shell compact={compact} icon={<Spinner size="sm" />} title={t('viewer.block.mcpStarting.title')} body={t('viewer.block.mcpStarting.body')} />;
      }
      if (block.state === 'binary_missing') {
        return (
          <Shell
            compact={compact}
            tone="danger"
            icon={<PlugConnection />}
            title={t('viewer.block.binaryMissing.title')}
            body={
              <>
                {t('viewer.block.binaryMissing.body')}
                <span className="mt-1 block font-mono text-[11px] break-all text-white/50" dir="ltr">
                  {block.binaryPath}
                </span>
              </>
            }
          >
            <Button size={size} variant="secondary" onPress={() => navigate({ name: 'settings', section: 'connection' })}>
              <Gear className="size-3.5" />
              {t('viewer.block.binaryMissing.action')}
            </Button>
          </Shell>
        );
      }
      return (
        <Shell
          compact={compact}
          tone="danger"
          icon={<PlugConnection />}
          title={block.state === 'crashed' ? t('viewer.block.mcpCrashed.title') : t('viewer.block.mcpStopped.title')}
          body={
            <>
              {t('viewer.block.mcpCrashed.body')}
              {block.lastError ? <span className="mt-1 block font-mono text-[11px] break-words text-white/50">{block.lastError}</span> : null}
            </>
          }
        >
          {canControl ? (
            <Button size={size} variant="secondary" isPending={busy === 'restart'} onPress={() => void run('restart', restartMirroir)}>
              <ArrowsRotateRight className="size-3.5" />
              {t('viewer.block.mcpCrashed.action')}
            </Button>
          ) : null}
        </Shell>
      );
    }

    case 'not_running':
      return (
        <Shell compact={compact} tone="warning" icon={<Smartphone />} title={t('viewer.block.notRunning.title')} body={t('viewer.block.notRunning.body')}>
          {canControl ? (
            <Button size={size} variant="primary" isPending={busy === 'open'} onPress={() => void run('open', openMirroring)}>
              <ArrowUpRightFromSquare className="size-3.5" />
              {t('viewer.openMirroring')}
            </Button>
          ) : null}
        </Shell>
      );

    case 'no_window':
      return (
        <Shell
          compact={compact}
          tone="warning"
          icon={<ShieldExclamation />}
          title={t('viewer.block.noWindow.title')}
          body={block.accessibilityGranted ? t('viewer.block.noWindow.bodyGranted') : t('viewer.block.noWindow.body')}
        >
          {!compact && !block.accessibilityGranted ? <PermissionBanner panes={['accessibility']} compact className="w-full bg-black/40" /> : null}
          <Button size={size} variant="secondary" isPending={busy === 'check'} onPress={() => void run('check', checkConnection)}>
            <ArrowsRotateRight className="size-3.5" />
            {t('viewer.checkAgain')}
          </Button>
        </Shell>
      );

    case 'paused':
      return (
        <Shell compact={compact} tone="warning" icon={<CirclePlay />} title={t('viewer.block.paused.title')} body={t('viewer.block.paused.body')}>
          {canControl ? (
            <>
              <Button size={size} variant="primary" isPending={refreshing} onPress={() => void refresh({ resume: true })}>
                <CirclePlay className="size-3.5" />
                {t('viewer.block.paused.resume')}
              </Button>
              {!compact ? <p className="text-[11px] leading-relaxed text-white/50">{t('viewer.block.paused.note')}</p> : null}
            </>
          ) : null}
        </Shell>
      );

    case 'screen_recording':
      return (
        <Shell
          compact={compact}
          tone="warning"
          icon={<ShieldExclamation />}
          title={t('viewer.block.screenRecording.title')}
          body={t('viewer.block.screenRecording.body')}
        >
          {!compact ? <PermissionBanner panes={['screen-recording']} compact className="w-full bg-black/40" /> : null}
        </Shell>
      );

    case 'unknown':
      return (
        <Shell
          compact={compact}
          tone={block.error ? 'danger' : 'default'}
          icon={block.error ? <TriangleExclamation /> : <Spinner size="sm" />}
          title={block.error ? t('viewer.block.error.title') : t('viewer.block.unknown.title')}
          body={
            block.rawStatus ? (
              <span className="font-mono text-[11px] break-words" dir="ltr">
                {block.rawStatus}
              </span>
            ) : (
              t('viewer.block.unknown.body')
            )
          }
        >
          <Button size={size} variant="secondary" isPending={busy === 'check'} onPress={() => void run('check', checkConnection)}>
            <ArrowsRotateRight className="size-3.5" />
            {t('viewer.checkNow')}
          </Button>
        </Shell>
      );

    case 'waiting':
      return (
        <Shell
          compact={compact}
          icon={<Spinner size="sm" />}
          title={t('viewer.block.waiting.title')}
          body={block.pausedReason ? t('viewer.block.waiting.paused', { reason: block.pausedReason }) : t('viewer.block.waiting.body')}
        >
          {canControl ? (
            <Button size={size} variant="secondary" isPending={refreshing} onPress={() => void refresh()}>
              <ArrowsRotateRight className="size-3.5" />
              {t('viewer.captureNow')}
            </Button>
          ) : null}
        </Shell>
      );
  }
}
