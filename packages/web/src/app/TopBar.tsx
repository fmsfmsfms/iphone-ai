// Top status bar: target device, Mirroir MCP and Mirroring state, warnings,
// AI provider, control mode, manual-control indicator and the STOP button.

import { Hand, ShieldExclamation, Smartphone } from '@gravity-ui/icons';
import { Button, Popover, Tooltip } from '@heroui/react';

import { PermissionBanner } from '../components/PermissionBanner';
import { StatusChip } from '../components/StatusChip';
import { mcpChip, missingPermissions, mirroringChip } from '../lib/device-state';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useAppStore } from '../state/store';
import { ControlModeSelector } from './ControlModeSelector';
import { ProviderSwitcher } from './ProviderSwitcher';
import { StopControl } from './StopControl';

function TargetIndicator() {
  const { t, formatNumber } = useI18n();
  const mirroring = useAppStore((s) => s.status?.mirroring ?? null);
  const chip = mirroringChip(mirroring?.state);
  const geometry = mirroring?.geometry;
  const target = mirroring?.target && mirroring.target.toLowerCase() !== 'iphone' ? mirroring.target : t('topbar.iphone');
  const dot =
    chip.tone === 'success' ? 'text-success' : chip.tone === 'warning' ? 'text-warning' : chip.tone === 'danger' ? 'text-danger' : 'text-muted';
  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-2.5"
      title={
        [mirroring?.rawStatus, geometry ? `${formatNumber(geometry.widthPt)}×${formatNumber(geometry.heightPt)} ${t('common.pt')}` : '']
          .filter(Boolean)
          .join('\n') || undefined
      }
    >
      <span aria-hidden className="relative flex size-8 shrink-0 items-center justify-center rounded-xl bg-default text-foreground [&>svg]:size-4">
        <Smartphone />
        <span className={['status-dot absolute -end-0.5 -bottom-0.5 ring-2 ring-background', dot].join(' ')} />
      </span>
      <div className="hidden min-w-0 flex-col leading-tight sm:flex">
        <span className="truncate text-[13px] font-semibold text-foreground">{target}</span>
        <span className="truncate text-[11px] text-muted">{t(chip.labelKey)}</span>
      </div>
    </div>
  );
}

function PermissionWarnings() {
  const { t } = useI18n();
  const status = useAppStore((s) => s.status);
  const missing = missingPermissions(status);
  if (missing.length === 0) return null;
  return (
    <Popover>
      <Button
        variant="tertiary"
        size="sm"
        className="h-7 shrink-0 gap-1.5 rounded-full bg-warning/12 px-2.5 text-xs font-medium text-warning"
        aria-label={t('topbar.permissionsMissing', { count: missing.length })}
      >
        <ShieldExclamation className="size-3.5" />
        <span className="hidden xl:inline">
          {missing.length === 1
            ? t(missing[0] === 'screen-recording' ? 'topbar.screenRecordingMissing' : 'topbar.accessibilityMissing')
            : t('topbar.permissionsMissing', { count: missing.length })}
        </span>
      </Button>
      <Popover.Content placement="bottom" className="w-[24rem] max-w-[calc(100vw-2rem)]">
        <Popover.Dialog className="p-2">
          <PermissionBanner panes={missing} />
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

function ManualIndicator() {
  const { t } = useI18n();
  const manual = useAppStore((s) => s.settings?.permissions.manualControlEnabled ?? false);
  if (!manual) return null;
  return (
    <Tooltip delay={300}>
      <Button
        variant="tertiary"
        size="sm"
        aria-label={t('topbar.manualOn')}
        onPress={() => navigate({ name: 'live' })}
        className="h-7 shrink-0 gap-1.5 rounded-full bg-accent/12 px-2.5 text-xs font-medium text-accent"
      >
        <Hand className="size-3.5" />
        <span className="hidden 2xl:inline">{t('topbar.manualOn')}</span>
      </Button>
      <Tooltip.Content placement="bottom" className="max-w-64 text-xs leading-relaxed">
        <p className="font-medium">{t('topbar.manualOn')}</p>
        <p className="mt-0.5 text-muted">{t('topbar.manualOnHint')}</p>
      </Tooltip.Content>
    </Tooltip>
  );
}

function ConnectionChips() {
  const { t } = useI18n();
  const server = useAppStore((s) => s.status?.server ?? null);
  const mirroringState = useAppStore((s) => s.status?.mirroring.state);
  const mcp = mcpChip(server?.state);
  const mirroring = mirroringChip(mirroringState);
  const mcpTooltip = (
    <span className="block space-y-1">
      <span className="block">{t(mcp.hintKey)}</span>
      {server?.version ? <span className="block text-muted">{t('topbar.mcpVersion', { version: server.version })}</span> : null}
      {server?.lastError && server.state !== 'ready' ? <span className="block text-danger">{server.lastError}</span> : null}
    </span>
  );
  return (
    <div className="hidden shrink-0 items-center gap-1.5 md:flex">
      <StatusChip
        tone={mcp.tone}
        pulse={server?.state === 'starting' || server?.state === 'restarting'}
        label={
          <>
            <span className="2xl:hidden">{t('topbar.mcpShort')}</span>
            <span className="hidden 2xl:inline">{t(mcp.labelKey)}</span>
          </>
        }
        tooltip={mcpTooltip}
      />
      <StatusChip
        tone={mirroring.tone}
        pulse={mirroringState === 'unknown'}
        label={
          <>
            <span className="2xl:hidden">{t('topbar.mirroringShort')}</span>
            <span className="hidden 2xl:inline">{t(mirroring.labelKey)}</span>
          </>
        }
        tooltip={t(mirroring.hintKey)}
      />
    </div>
  );
}

function ReconnectingChip() {
  const { t } = useI18n();
  const socket = useAppStore((s) => s.connection.socket);
  if (socket === 'open' || socket === 'idle') return null;
  return <StatusChip tone="warning" pulse label={t('topbar.reconnecting')} tooltip={t('topbar.reconnectingHint')} size="sm" />;
}

export function TopBar() {
  const { t } = useI18n();
  return (
    <header
      className="app-glass relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-hairline px-4"
      aria-label={t('topbar.label')}
    >
      {/* Status takes whatever room is left: on narrow windows it is clipped, never STOP. */}
      <div className="flex min-w-0 flex-1 items-center gap-3 self-stretch overflow-hidden">
        <TargetIndicator />
        <span aria-hidden className="hidden h-6 w-px bg-hairline md:block" />
        <ConnectionChips />
        <PermissionWarnings />
        <ReconnectingChip />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ManualIndicator />
        <ProviderSwitcher />
        <ControlModeSelector />
        <StopControl />
      </div>
    </header>
  );
}
