// iPhone Connection: Mirroir program and target, request timeout, live view
// (ScreenCaptureKit) and screenshot polling, Mirroir doctor results, macOS
// permissions and connection actions.

import {
  ArrowsRotateRight,
  ArrowUpRightFromSquare,
  CircleCheckFill,
  CircleXmarkFill,
  Display,
  PlugConnection,
  Smartphone,
  Stethoscope,
  TriangleExclamationFill,
} from '@gravity-ui/icons';
import { DEFAULT_LIVE_FPS, type HealthCheckItem, type PermissionState } from '@iphone-ai/shared';
import { Button, Skeleton, Spinner } from '@heroui/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { KeyValueList } from '../../components/KeyValue';
import { Panel } from '../../components/Panel';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { api, errorMessage, type DoctorCheck, type HealthCheckResponse, type SettingsPane } from '../../lib/api';
import { mcpChip, mirroringChip } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { applyStatus, notify, notifyError, refreshConnection, restartMcp, useStatus, useStream } from '../../state/store';
import { errorFor } from './helpers';
import { Notice, NumberRow, Rows, SaveBar, SettingRow, SwitchRow, TextInput, useEditable } from './fields';
import { SectionFrame, useSectionAccess } from './SectionFrame';
import { useSectionForm } from './useSectionForm';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

function normalizeStatus(status: string): CheckStatus {
  const s = status.toLowerCase();
  if (['ok', 'pass', 'passed', 'success', 'granted'].includes(s)) return 'ok';
  if (['warn', 'warning'].includes(s)) return 'warn';
  if (['fail', 'failed', 'error', 'denied', 'missing'].includes(s)) return 'fail';
  return 'unknown';
}

function CheckIcon({ status }: { status: CheckStatus }) {
  if (status === 'ok') return <CircleCheckFill aria-hidden className="size-4 shrink-0 text-success" />;
  if (status === 'warn') return <TriangleExclamationFill aria-hidden className="size-4 shrink-0 text-warning" />;
  if (status === 'fail') return <CircleXmarkFill aria-hidden className="size-4 shrink-0 text-danger" />;
  return <span aria-hidden className="mt-1 size-2 shrink-0 rounded-full bg-muted" />;
}

function CheckList({ items }: { items: { name: string; status: CheckStatus; detail: string; fixHint?: string | undefined }[] }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col divide-y divide-hairline">
      {items.map((item, i) => (
        <li key={`${item.name}-${i}`} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
          <span className="mt-0.5">
            <CheckIcon status={item.status} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-5 font-medium text-foreground" dir="auto">
              {item.name}
              <span className="sr-only"> — {t(`settings.connection.check.${item.status}`)}</span>
            </p>
            {item.detail ? (
              <p className="text-xs leading-relaxed break-words text-muted" dir="auto">
                {item.detail}
              </p>
            ) : null}
            {item.fixHint && item.status !== 'ok' ? (
              <p className="mt-1 text-xs leading-relaxed text-warning" dir="auto">
                <span className="font-medium">{t('settings.connection.fixHint')}</span> {item.fixHint}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function DoctorPanel() {
  const { t } = useI18n();
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.connection.doctor();
      setChecks(res.checks);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const failing = checks?.filter((c) => normalizeStatus(c.status) !== 'ok').length ?? 0;

  return (
    <Panel
      icon={<Stethoscope />}
      title={t('settings.connection.doctor.title')}
      description={t('settings.connection.doctor.description')}
      actions={
        <Button size="sm" variant="ghost" isPending={loading} onPress={() => void load()}>
          {loading ? null : <ArrowsRotateRight className="size-3.5" />}
          {t('settings.connection.doctor.run')}
        </Button>
      }
    >
      {checks === null && loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <Notice tone="danger" icon={<TriangleExclamationFill />} title={t('settings.connection.doctor.failed')}>
          {error}
        </Notice>
      ) : checks && checks.length === 0 ? (
        <p className="text-[13px] text-muted">{t('settings.connection.doctor.empty')}</p>
      ) : checks ? (
        <div className="flex flex-col gap-3">
          <StatusChip
            tone={failing === 0 ? 'success' : 'warning'}
            label={failing === 0 ? t('settings.connection.doctor.allOk') : t('settings.connection.doctor.issues', { count: failing })}
          />
          <CheckList items={checks.map((c) => ({ name: c.name, status: normalizeStatus(c.status), detail: c.detail, fixHint: c.fix_hint }))} />
        </div>
      ) : null}
    </Panel>
  );
}

const PERMISSION_TONE: Record<PermissionState, 'success' | 'danger' | 'warning'> = {
  granted: 'success',
  denied: 'danger',
  unknown: 'warning',
};

function PermissionRow({ pane, state, title, description }: { pane: SettingsPane; state: PermissionState | null; title: string; description: string }) {
  const { t } = useI18n();
  const editable = useEditable();
  const [opening, setOpening] = useState(false);
  const open = async () => {
    setOpening(true);
    try {
      const res = await api.connection.openSettings(pane);
      if (!res.opened) notify('warning', t('settings.connection.permissions.notOpened'), t('settings.connection.permissions.notOpenedBody'));
    } catch (err) {
      notifyError(t('settings.connection.permissions.openFailed'), err);
    } finally {
      setOpening(false);
    }
  };
  return (
    <SettingRow
      label={title}
      description={description}
      badge={state ? <StatusChip size="sm" tone={PERMISSION_TONE[state]} label={t(`permission.state.${state}`)} /> : null}
    >
      <Button size="sm" variant="secondary" isDisabled={!editable} isPending={opening} onPress={() => void open()}>
        {opening ? null : <ArrowUpRightFromSquare className="size-3.5" />}
        {t('settings.connection.permissions.open')}
      </Button>
    </SettingRow>
  );
}

function ActionButton({ icon, label, onPress, pending, disabled }: { icon: ReactNode; label: string; onPress: () => void; pending: boolean; disabled?: boolean }) {
  return (
    <Button size="sm" variant="secondary" isPending={pending} isDisabled={disabled} onPress={onPress}>
      {pending ? null : <span className="flex size-3.5 items-center justify-center [&>svg]:size-3.5">{icon}</span>}
      {label}
    </Button>
  );
}

function StatusPanel() {
  const { t } = useI18n();
  const status = useStatus();
  const editable = useEditable();
  const [pending, setPending] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);

  const run = async (key: string, fn: () => Promise<void>, errorKey: string) => {
    setPending(key);
    try {
      await fn();
    } catch (err) {
      notifyError(t(errorKey), err);
    } finally {
      setPending(null);
    }
  };

  const server = status?.server;
  const mirroring = status?.mirroring;
  const mcp = mcpChip(server?.state);
  const mir = mirroringChip(mirroring?.state);

  return (
    <Panel
      icon={<PlugConnection />}
      title={t('settings.connection.status.title')}
      description={t('settings.connection.status.description')}
      footer={
        <div className="flex flex-wrap gap-2">
          <ActionButton
            icon={<ArrowsRotateRight />}
            label={t('settings.connection.actions.refresh')}
            pending={pending === 'refresh'}
            onPress={() =>
              void run(
                'refresh',
                async () => {
                  await refreshConnection();
                },
                'settings.connection.actions.refreshFailed',
              )
            }
          />
          <ActionButton
            icon={<PlugConnection />}
            label={t('settings.connection.actions.restart')}
            pending={pending === 'restart'}
            disabled={!editable}
            onPress={() => setConfirmRestart(true)}
          />
          <ActionButton
            icon={<Smartphone />}
            label={t('settings.connection.actions.openMirroring')}
            pending={pending === 'open'}
            disabled={!editable}
            onPress={() =>
              void run(
                'open',
                async () => {
                  const res = await api.connection.openMirroring();
                  if (res.opened) notify('info', t('viewer.openMirroring.opened'));
                  else notify('warning', t('viewer.openMirroring.notOpened'), t('viewer.openMirroring.notOpenedBody'));
                },
                'viewer.openMirroring.failed',
              )
            }
          />
          <ActionButton
            icon={<Stethoscope />}
            label={t('settings.connection.actions.health')}
            pending={pending === 'health'}
            disabled={!editable}
            onPress={() =>
              void run(
                'health',
                async () => {
                  setHealth(await api.connection.checkHealth());
                  // The health check may have refreshed permissions; pull the latest status.
                  api.status().then(applyStatus, () => undefined);
                },
                'settings.connection.actions.healthFailed',
              )
            }
          />
        </div>
      }
    >
      {!status ? (
        <Spinner size="sm" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <StatusChip tone={mcp.tone} label={t(mcp.labelKey)} tooltip={t(mcp.hintKey)} pulse={server?.state === 'starting' || server?.state === 'restarting'} />
            <StatusChip tone={mir.tone} label={t(mir.labelKey)} tooltip={t(mir.hintKey)} />
          </div>
          <KeyValueList
            dense
            items={[
              { key: 'version', label: t('settings.connection.status.version'), value: <bdi dir="ltr">{server?.version ?? t('settings.connection.status.unknown')}</bdi>, mono: true },
              { key: 'binary', label: t('settings.connection.status.binary'), value: <bdi dir="ltr">{server?.binaryPath ?? '—'}</bdi>, mono: true },
              { key: 'pid', label: t('settings.connection.status.pid'), value: <bdi dir="ltr">{server?.pid ?? '—'}</bdi>, mono: true },
              { key: 'restarts', label: t('settings.connection.status.restarts'), value: String(server?.restartCount ?? 0) },
              { key: 'checked', label: t('settings.connection.status.checked'), value: <RelativeTime at={mirroring?.checkedAt ?? null} /> },
              ...(server?.lastError
                ? [{ key: 'error', label: t('settings.connection.status.lastError'), value: <span className="text-danger" dir="auto">{server.lastError}</span> }]
                : []),
            ]}
          />
          {mirroring?.rawStatus ? (
            <pre dir="ltr" className="rounded-xl border border-hairline bg-surface-secondary px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground/85">
              {mirroring.rawStatus}
            </pre>
          ) : null}
          <p className="text-xs leading-relaxed text-muted">{t('settings.connection.actions.healthHint')}</p>
          {health ? (
            <div className="flex flex-col gap-2 rounded-xl border border-hairline p-3">
              <StatusChip tone={health.ok ? 'success' : 'warning'} label={health.ok ? t('settings.connection.health.ok') : t('settings.connection.health.issues')} />
              {health.items.length > 0 ? (
                <CheckList
                  items={health.items.map((item: HealthCheckItem) => ({ name: item.name, status: item.status, detail: item.detail, fixHint: item.fixHint }))}
                />
              ) : (
                <pre dir="ltr" className="font-mono text-[11.5px] whitespace-pre-wrap text-muted">
                  {health.raw}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        isOpen={confirmRestart}
        onOpenChange={setConfirmRestart}
        title={t('settings.connection.restart.title')}
        confirmLabel={t('settings.connection.restart.confirm')}
        tone="warning"
        icon={<PlugConnection />}
        onConfirm={async () => {
          await restartMcp();
          notify('success', t('viewer.restart.done'));
        }}
      >
        <p>{t('settings.connection.restart.body')}</p>
      </ConfirmDialog>
    </Panel>
  );
}

export function ConnectionSection() {
  const { t } = useI18n();
  const status = useStatus();
  const stream = useStream();
  const access = useSectionAccess('local');
  const form = useSectionForm('connection');
  const draft = form.draft;
  if (!draft) return null;
  // Settings saved before live capture existed may lack its keys; the defaults apply until changed.
  const shot = {
    ...draft.screenshot,
    liveCapture: draft.screenshot.liveCapture ?? true,
    liveFps: draft.screenshot.liveFps ?? DEFAULT_LIVE_FPS,
  };
  const liveProblem = shot.liveCapture && stream && !stream.liveAvailable ? stream.liveError : null;
  const binaryChanged = Boolean(form.patch.mirroirBinaryPath !== undefined || form.patch.target !== undefined);

  return (
    <SectionFrame title={t('settings.connection.title')} description={t('settings.connection.description')} icon={<PlugConnection />} access={access}>
      <StatusPanel />

      <Panel icon={<Smartphone />} title={t('settings.connection.mirroir.title')} description={t('settings.connection.mirroir.description')}>
        <Rows>
          <SettingRow
            label={t('settings.connection.binary.label')}
            description={t('settings.connection.binary.description')}
            error={errorFor(form.errors, 'mirroirBinaryPath')}
            stacked
          >
            <TextInput
              label={t('settings.connection.binary.label')}
              value={draft.mirroirBinaryPath}
              onChange={(v) => form.set('mirroirBinaryPath', v)}
              placeholder="/opt/homebrew/bin/mirroir"
              mono
              maxLength={500}
              invalid={Boolean(errorFor(form.errors, 'mirroirBinaryPath'))}
            />
          </SettingRow>
          <SettingRow label={t('settings.connection.target.label')} description={t('settings.connection.target.description')} error={errorFor(form.errors, 'target')}>
            <TextInput
              label={t('settings.connection.target.label')}
              value={draft.target}
              onChange={(v) => form.set('target', v)}
              placeholder="iphone"
              mono
              maxLength={60}
              className="sm:w-56"
              invalid={Boolean(errorFor(form.errors, 'target'))}
            />
          </SettingRow>
          <NumberRow
            label={t('settings.connection.timeout.label')}
            description={t('settings.connection.timeout.description')}
            value={draft.requestTimeoutMs}
            onChange={(v) => form.set('requestTimeoutMs', v ?? Number.NaN)}
            scale={1000}
            minValue={5000}
            maxValue={600000}
            unit={t('settings.unit.seconds')}
            error={errorFor(form.errors, 'requestTimeoutMs')}
          />
        </Rows>
        {binaryChanged ? (
          <Notice tone="default" className="mt-3">
            {t('settings.connection.binary.restartNote')}
          </Notice>
        ) : null}
        {status?.server.state === 'binary_missing' ? (
          <Notice tone="danger" icon={<TriangleExclamationFill />} className="mt-3" title={t('settings.connection.binary.missingTitle')}>
            {t('settings.connection.binary.missingBody')}
          </Notice>
        ) : null}
      </Panel>

      <Panel icon={<Display />} title={t('settings.connection.polling.title')} description={t('settings.connection.polling.description')}>
        <Notice tone="default" className="mb-4">
          {t('settings.connection.polling.honest')}
        </Notice>
        <Rows>
          <SwitchRow
            label={t('settings.connection.live.label')}
            description={
              <>
                {t('settings.connection.live.description')}
                {liveProblem ? (
                  <span className="mt-1 block text-warning" dir="auto">
                    {liveProblem}
                  </span>
                ) : null}
              </>
            }
            isSelected={shot.liveCapture}
            onChange={(liveCapture) => form.set('screenshot', { ...shot, liveCapture })}
            error={errorFor(form.errors, 'screenshot.liveCapture')}
            badge={
              !shot.liveCapture || !stream ? null : stream.liveAvailable ? (
                <StatusChip size="sm" tone="success" label={t('settings.connection.live.available')} />
              ) : (
                <StatusChip size="sm" tone="warning" label={t('settings.connection.live.unavailable')} />
              )
            }
          />
          <NumberRow
            label={t('settings.connection.live.fps.label')}
            description={t('settings.connection.live.fps.description')}
            value={shot.liveFps}
            onChange={(v) => form.set('screenshot', { ...shot, liveFps: v ?? Number.NaN })}
            minValue={5}
            maxValue={60}
            step={1}
            unit={t('settings.unit.fps')}
            isDisabled={!shot.liveCapture}
            error={errorFor(form.errors, 'screenshot.liveFps')}
          />
        </Rows>
        <h3 className="mt-5 mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{t('settings.connection.polling.subtitle')}</h3>
        {!shot.liveCapture ? <p className="mb-2 text-xs leading-relaxed text-muted">{t('settings.connection.live.off')}</p> : null}
        <Rows>
          <NumberRow
            label={t('settings.connection.polling.active.label')}
            description={t('settings.connection.polling.active.description')}
            value={shot.activeFps}
            onChange={(v) => form.set('screenshot', { ...shot, activeFps: v ?? Number.NaN })}
            minValue={0.2}
            maxValue={10}
            step={0.1}
            maximumFractionDigits={2}
            unit={t('settings.unit.fps')}
            error={errorFor(form.errors, 'screenshot.activeFps')}
          />
          <NumberRow
            label={t('settings.connection.polling.idle.label')}
            description={t('settings.connection.polling.idle.description')}
            value={shot.idleFps}
            onChange={(v) => form.set('screenshot', { ...shot, idleFps: v ?? Number.NaN })}
            minValue={0}
            maxValue={2}
            step={0.1}
            maximumFractionDigits={2}
            unit={t('settings.unit.fps')}
            error={errorFor(form.errors, 'screenshot.idleFps')}
          />
          <NumberRow
            label={t('settings.connection.polling.idleAfter.label')}
            description={t('settings.connection.polling.idleAfter.description')}
            value={shot.idleAfterMs}
            onChange={(v) => form.set('screenshot', { ...shot, idleAfterMs: v ?? Number.NaN })}
            scale={1000}
            minValue={5000}
            maxValue={3600000}
            unit={t('settings.unit.seconds')}
            error={errorFor(form.errors, 'screenshot.idleAfterMs')}
          />
          <SwitchRow
            label={t('settings.connection.polling.pause.label')}
            description={t('settings.connection.polling.pause.description')}
            isSelected={shot.pauseWhenHidden}
            onChange={(pauseWhenHidden) => form.set('screenshot', { ...shot, pauseWhenHidden })}
          />
        </Rows>
      </Panel>

      <Panel title={t('settings.connection.permissions.title')} description={t('settings.connection.permissions.description')}>
        <Rows>
          <PermissionRow
            pane="screen-recording"
            state={status?.permissions.screenRecording ?? null}
            title={t('settings.connection.permissions.screenRecording')}
            description={t('permission.screenRecording.body')}
          />
          <PermissionRow
            pane="accessibility"
            state={status?.permissions.accessibility ?? null}
            title={t('settings.connection.permissions.accessibility')}
            description={t('permission.accessibility.body')}
          />
          <PermissionRow pane="automation" state={null} title={t('settings.connection.permissions.automation')} description={t('permission.automation.body')} />
        </Rows>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {t('permission.ownership')}
          {status?.permissions.checkedAt ? (
            <>
              {' '}
              {t('settings.connection.permissions.checked', { source: status.permissions.source })} <RelativeTime at={status.permissions.checkedAt} />
            </>
          ) : null}
        </p>
      </Panel>

      <DoctorPanel />

      <SaveBar dirty={form.dirty} status={form.status} error={form.generalError} onSave={() => void form.save()} onDiscard={form.discard} />
    </SectionFrame>
  );
}
