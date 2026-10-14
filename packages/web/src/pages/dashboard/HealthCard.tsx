// Connection & health: Mirroir's own status text (verbatim), MCP process
// details, permissions and an on-demand `check_health` run.

import { ArrowsRotateRight, CircleCheckFill, CircleXmarkFill, HeartPulse, TriangleExclamationFill } from '@gravity-ui/icons';
import type { HealthCheckItem, PermissionState } from '@iphone-ai/shared';
import { Button, Tooltip } from '@heroui/react';
import { useState } from 'react';

import { KeyValueList } from '../../components/KeyValue';
import { Panel, Section } from '../../components/Panel';
import { checkConnection, restartMirroir } from '../../components/phone/phone-actions';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { api, type HealthCheckResponse } from '../../lib/api';
import { mcpChip, mirroringChip } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { notifyError, useAppStore, useCanControl } from '../../state/store';

function PermissionChip({ state }: { state: PermissionState }) {
  const { t } = useI18n();
  const tone = state === 'granted' ? 'success' : state === 'denied' ? 'danger' : 'warning';
  return <StatusChip tone={tone} size="sm" label={t(`permission.state.${state}`)} />;
}

const HEALTH_ICON = {
  ok: <CircleCheckFill className="size-4 text-success" />,
  warn: <TriangleExclamationFill className="size-4 text-warning" />,
  fail: <CircleXmarkFill className="size-4 text-danger" />,
} as const;

function HealthResults({ result }: { result: HealthCheckResponse }) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-hairline bg-background/50 p-3">
      <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-foreground">
        {result.ok ? HEALTH_ICON.ok : HEALTH_ICON.warn}
        {result.ok ? t('dashboard.health.resultsOk') : t('dashboard.health.resultsIssues')}
      </p>
      <ul className="flex flex-col gap-2">
        {result.items.map((item: HealthCheckItem, i) => (
          <li key={`${item.name}-${i}`} className="flex gap-2.5">
            <span className="mt-0.5 shrink-0">{HEALTH_ICON[item.status]}</span>
            <div className="min-w-0">
              <p className="text-[13px] text-foreground">{item.name}</p>
              {item.detail ? <p className="text-xs leading-relaxed break-words text-muted">{item.detail}</p> : null}
              {item.fixHint ? <p className="mt-0.5 text-xs leading-relaxed text-warning">{item.fixHint}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HealthCard() {
  const { t, formatNumber } = useI18n();
  const status = useAppStore((s) => s.status);
  const canControl = useCanControl();
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<HealthCheckResponse | null>(null);

  if (!status) return null;
  const { server, mirroring, permissions } = status;
  const mcp = mcpChip(server.state);
  const mir = mirroringChip(mirroring.state);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await checkConnection();
    } finally {
      setRefreshing(false);
    }
  };

  const restart = async () => {
    setRestarting(true);
    try {
      await restartMirroir();
    } finally {
      setRestarting(false);
    }
  };

  const runHealth = async () => {
    setChecking(true);
    try {
      setResult(await api.connection.checkHealth());
    } catch (err) {
      notifyError(t('dashboard.health.failed'), err);
    } finally {
      setChecking(false);
    }
  };

  return (
    <Panel
      icon={<HeartPulse />}
      title={t('dashboard.health.title')}
      description={t('dashboard.health.description')}
      actions={
        <>
          <Button size="sm" variant="ghost" isPending={refreshing} onPress={() => void refresh()}>
            <ArrowsRotateRight className="size-3.5" />
            {t('dashboard.refreshStatus')}
          </Button>
          {canControl ? (
            <Button size="sm" variant="ghost" isPending={restarting} onPress={() => void restart()}>
              {t('dashboard.health.restart')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Section title={t('dashboard.health.rawStatus')}>
          <pre className="rounded-xl border border-hairline bg-background/60 px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground" dir="ltr">
            {mirroring.rawStatus || t('dashboard.health.noRawStatus')}
          </pre>
        </Section>

        <div className="grid gap-5 lg:grid-cols-2">
          <Section title={t('dashboard.health.mcp')}>
            <KeyValueList
              dense
              items={[
                { label: t('dashboard.health.state'), value: <StatusChip tone={mcp.tone} size="sm" label={t(mcp.labelKey)} /> },
                { label: t('dashboard.health.pid'), value: server.pid ?? '—', mono: true },
                { label: t('dashboard.health.version'), value: server.version ?? '—', mono: true },
                { label: t('dashboard.health.protocol'), value: server.protocolVersion ?? '—', mono: true },
                { label: t('dashboard.health.tools'), value: t('dashboard.health.toolsValue', { count: server.tools.length }) },
                { label: t('dashboard.health.restarts'), value: formatNumber(server.restartCount) },
                { label: t('dashboard.health.started'), value: <RelativeTime at={server.startedAt} fallback="—" /> },
                { label: t('dashboard.health.binary'), value: server.binaryPath, mono: true },
                ...(server.permissionFile ? [{ label: t('dashboard.health.permissionFile'), value: server.permissionFile, mono: true }] : []),
                ...(server.lastError ? [{ label: t('dashboard.health.lastError'), value: <span className="text-danger">{server.lastError}</span> }] : []),
              ]}
            />
          </Section>
          <div className="flex flex-col gap-5">
            <Section title={t('dashboard.health.mirroring')}>
              <KeyValueList
                dense
                items={[
                  { label: t('dashboard.health.state'), value: <StatusChip tone={mir.tone} size="sm" label={t(mir.labelKey)} /> },
                  { label: t('dashboard.health.target'), value: mirroring.target || '—', mono: true },
                  {
                    label: t('dashboard.health.window'),
                    value: mirroring.geometry
                      ? t('dashboard.health.windowValue', {
                          width: mirroring.geometry.widthPt,
                          height: mirroring.geometry.heightPt,
                          orientation: t(`orientation.${mirroring.geometry.orientation}`),
                        })
                      : '—',
                  },
                  { label: t('dashboard.health.checked'), value: <RelativeTime at={mirroring.checkedAt} /> },
                ]}
              />
            </Section>
            <Section title={t('dashboard.health.permissions')}>
              <KeyValueList
                dense
                items={[
                  { label: t('dashboard.health.screenRecording'), value: <PermissionChip state={permissions.screenRecording} /> },
                  { label: t('dashboard.health.accessibility'), value: <PermissionChip state={permissions.accessibility} /> },
                  {
                    label: t('dashboard.health.checked'),
                    value: <RelativeTime at={permissions.checkedAt} />,
                    hint: permissions.source ? t('dashboard.health.permissionSource', { source: permissions.source }) : undefined,
                  },
                ]}
              />
            </Section>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip delay={300}>
              <Button size="sm" variant="secondary" isPending={checking} isDisabled={!canControl} onPress={() => void runHealth()}>
                <HeartPulse className="size-3.5" />
                {t('dashboard.health.run')}
              </Button>
              <Tooltip.Content className="max-w-72 text-xs leading-relaxed">{t('dashboard.health.runHint')}</Tooltip.Content>
            </Tooltip>
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">{t('dashboard.health.runHint')}</p>
          </div>
          {result ? <HealthResults result={result} /> : null}
        </div>
      </div>
    </Panel>
  );
}
