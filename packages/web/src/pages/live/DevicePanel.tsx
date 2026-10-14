// Left panel of Live Control: connection facts, honest stream numbers,
// permissions, the manual-control switch and manual input buttons.

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUturnCcwLeft,
  House,
  Layers,
  Magnifier,
  PaperPlane,
  SquareArticle,
} from '@gravity-ui/icons';
import type { DeviceAction } from '@iphone-ai/shared';
import { Button, Description, Input, Label, Switch, TextField, Tooltip } from '@heroui/react';
import { useState, type ReactNode, type RefObject } from 'react';

import { IconButton } from '../../components/IconButton';
import { KbdHint } from '../../components/KbdHint';
import { KeyValueList } from '../../components/KeyValue';
import { Section } from '../../components/Panel';
import { PermissionBanner } from '../../components/PermissionBanner';
import { sendManualAction } from '../../components/phone/phone-actions';
import { StatusChip } from '../../components/StatusChip';
import { manualInputAvailability, mcpChip, mirroringChip, missingPermissions } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { useActiveRun, useActiveTask, useAppStore } from '../../state/store';
import type { useManualControl } from './useManualControl';

type ManualControl = ReturnType<typeof useManualControl>;

export interface DevicePanelProps {
  manual: ManualControl;
  typeFieldRef: RefObject<HTMLInputElement | null>;
}

function ActionButton({
  label,
  hint,
  icon,
  disabledReason,
  onPress,
  pending,
}: {
  label: string;
  hint: string;
  icon: ReactNode;
  disabledReason: string | null;
  onPress: () => void;
  pending: boolean;
}) {
  const disabled = Boolean(disabledReason);
  const button = (
    <Button
      variant="secondary"
      size="sm"
      fullWidth
      isDisabled={disabled}
      isPending={pending}
      onPress={onPress}
      className="h-9 justify-start gap-2 rounded-xl [&_svg]:size-4"
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );
  return (
    <Tooltip delay={500} closeDelay={0}>
      {disabled ? <Tooltip.Trigger className="block w-full rounded-xl">{button}</Tooltip.Trigger> : button}
      <Tooltip.Content className="max-w-64 text-xs leading-relaxed">{disabled ? disabledReason : hint}</Tooltip.Content>
    </Tooltip>
  );
}

const KEYS: { key: string; labelKey: string; display: ReactNode }[] = [
  { key: 'return', labelKey: 'live.keys.return', display: <KbdHint keys={['enter']} /> },
  { key: 'delete', labelKey: 'live.keys.delete', display: <KbdHint keys={['delete']} /> },
  { key: 'escape', labelKey: 'live.keys.escape', display: <KbdHint keys={['escape']} /> },
  { key: 'tab', labelKey: 'live.keys.tab', display: <KbdHint keys={['tab']} /> },
  { key: 'space', labelKey: 'live.keys.space', display: <KbdHint keys={['space']} /> },
  { key: 'left', labelKey: 'live.keys.left', display: <ArrowLeft /> },
  { key: 'up', labelKey: 'live.keys.up', display: <ArrowUp /> },
  { key: 'down', labelKey: 'live.keys.down', display: <ArrowDown /> },
  { key: 'right', labelKey: 'live.keys.right', display: <ArrowRight /> },
];

export function DevicePanel({ manual, typeFieldRef }: DevicePanelProps) {
  const { t, formatNumber } = useI18n();
  const status = useAppStore((s) => s.status);
  const settings = useAppStore((s) => s.settings);
  const session = useAppStore((s) => s.session);
  const stream = useAppStore((s) => s.stream);
  const frame = useAppStore((s) => s.frame);
  const activeTask = useActiveTask();
  const activeRun = useActiveRun();
  const [pending, setPending] = useState<string | null>(null);
  const [appName, setAppName] = useState('');
  const [text, setText] = useState('');

  const availability = manualInputAvailability({ status, settings, session, activeTask, activeRun });
  const reason = availability.allowed ? null : t(availability.reasonKey ?? 'input.reason.loading');

  const send = async (id: string, action: DeviceAction): Promise<boolean> => {
    setPending(id);
    try {
      const result = await sendManualAction(action, {
        geometryId: status?.mirroring.geometry?.geometryId ?? null,
        frameSeq: frame?.seq ?? null,
      });
      return Boolean(result?.ok);
    } finally {
      setPending(null);
    }
  };

  const geometry = status?.mirroring.geometry ?? null;
  const mcp = mcpChip(status?.server.state);
  const mir = mirroringChip(status?.mirroring.state);
  const fps = (v: number) => t('live.device.fps', { value: formatNumber(v, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) });
  const missing = missingPermissions(status);

  const launch = async () => {
    const name = appName.trim();
    if (!name) return;
    if (await send('launch', { kind: 'launch_app', name })) setAppName('');
  };

  const typeText = async () => {
    if (!text) return;
    if (await send('type', { kind: 'type_text', text })) setText('');
  };

  return (
    <div className="app-scroll flex h-full flex-col gap-6 p-4" aria-label={t('live.panel.device')}>
      <Section title={t('live.device.connection')}>
        <KeyValueList
          dense
          items={[
            { label: t('live.device.target'), value: status?.mirroring.target || '—', mono: true },
            { label: t('live.device.mirroring'), value: <StatusChip tone={mir.tone} size="sm" label={t(mir.labelKey)} tooltip={status?.mirroring.rawStatus || undefined} /> },
            { label: t('live.device.mcp'), value: <StatusChip tone={mcp.tone} size="sm" label={t(mcp.labelKey)} tooltip={t(mcp.hintKey)} /> },
          ]}
        />
      </Section>

      <Section title={t('live.device.screen')}>
        <KeyValueList
          dense
          items={[
            {
              label: t('live.device.size'),
              value: geometry ? t('live.device.sizeValue', { width: geometry.widthPt, height: geometry.heightPt }) : t('live.device.unknown'),
            },
            { label: t('live.device.orientation'), value: geometry ? t(`orientation.${geometry.orientation}`) : t('live.device.unknown') },
            {
              label: t('live.device.scale'),
              value:
                frame?.pxPerPt != null
                  ? t('live.device.scaleValue', {
                      value: formatNumber(frame.pxPerPt, { maximumFractionDigits: 2 }),
                      width: frame.widthPx,
                      height: frame.heightPx,
                    })
                  : t('live.device.unknown'),
            },
          ]}
        />
      </Section>

      <Section title={t('live.device.updates')} description={t('live.device.updatesNote')}>
        <KeyValueList
          dense
          items={[
            { label: t('live.device.targetFps'), value: stream ? fps(stream.targetFps) : '—' },
            {
              label: t('live.device.measuredFps'),
              value: stream ? fps(stream.measuredFps) : '—',
              hint: stream && !stream.running && stream.pausedReason ? t('live.device.pollingPaused', { reason: stream.pausedReason }) : undefined,
            },
            { label: t('live.device.latency'), value: stream ? t('live.device.ms', { value: formatNumber(Math.round(stream.avgLatencyMs)) }) : '—' },
          ]}
        />
      </Section>

      <Section title={t('live.device.permissions')}>
        <div className="flex flex-wrap gap-1.5">
          <StatusChip
            size="sm"
            tone={status?.permissions.screenRecording === 'granted' ? 'success' : 'warning'}
            label={`${t('live.device.screenRecording')}: ${t(`permission.state.${status?.permissions.screenRecording ?? 'unknown'}`)}`}
          />
          <StatusChip
            size="sm"
            tone={status?.permissions.accessibility === 'granted' ? 'success' : 'warning'}
            label={`${t('live.device.accessibility')}: ${t(`permission.state.${status?.permissions.accessibility ?? 'unknown'}`)}`}
          />
        </div>
        {missing.length > 0 ? <PermissionBanner panes={missing} compact /> : null}
      </Section>

      <Section title={t('live.manual.title')}>
        <div className="rounded-xl border border-hairline bg-surface-secondary p-3">
          <Switch
            isSelected={manual.enabled}
            onChange={(next) => manual.request(next)}
            isDisabled={manual.cannotTurnOn || manual.pending}
            size="md"
          >
            <Switch.Content className="flex w-full items-center gap-3">
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label className="flex-1 text-[13px] font-medium text-foreground">{t('live.manual.switch')}</Label>
              <KbdHint keys={['M']} />
            </Switch.Content>
            <Description className="mt-2 block text-xs leading-relaxed text-muted">
              {!manual.canControl
                ? t('input.reason.viewOnly')
                : manual.enabled
                  ? t('live.manual.on')
                  : !manual.isLocal
                    ? t('live.manual.localOnly')
                    : t('live.manual.off')}
            </Description>
          </Switch>
        </div>
        {manual.enabled && reason ? <p className="text-xs leading-relaxed text-warning">{reason}</p> : null}
      </Section>

      <Section title={t('live.nav.title')}>
        <div className="grid grid-cols-2 gap-1.5">
          <ActionButton label={t('live.nav.home')} hint={t('live.nav.homeHint')} icon={<House />} disabledReason={reason} pending={pending === 'home'} onPress={() => void send('home', { kind: 'press_home' })} />
          <ActionButton
            label={t('live.nav.back')}
            hint={t('live.nav.backHint')}
            icon={<ArrowUturnCcwLeft className="rtl:-scale-x-100" />}
            disabledReason={reason}
            pending={pending === 'back'}
            onPress={() => void send('back', { kind: 'press_back' })}
          />
          <ActionButton
            label={t('live.nav.appSwitcher')}
            hint={t('live.nav.appSwitcherHint')}
            icon={<Layers />}
            disabledReason={reason}
            pending={pending === 'switcher'}
            onPress={() => void send('switcher', { kind: 'press_app_switcher' })}
          />
          <ActionButton
            label={t('live.nav.spotlight')}
            hint={t('live.nav.spotlightHint')}
            icon={<Magnifier />}
            disabledReason={reason}
            pending={pending === 'spotlight'}
            onPress={() => void send('spotlight', { kind: 'spotlight' })}
          />
        </div>
      </Section>

      <Section title={t('live.app.title')} description={t('live.app.hint')}>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void launch();
          }}
        >
          <TextField value={appName} onChange={setAppName} isDisabled={Boolean(reason)} className="min-w-0 flex-1" aria-label={t('live.app.label')}>
            <Input variant="secondary" placeholder={t('live.app.placeholder')} maxLength={120} />
          </TextField>
          <Button type="submit" size="sm" variant="secondary" className="h-9" isDisabled={Boolean(reason) || !appName.trim()} isPending={pending === 'launch'}>
            <SquareArticle className="size-3.5" />
            {t('live.app.open')}
          </Button>
        </form>
      </Section>

      <Section
        title={t('live.type.title')}
        description={t('live.type.hint')}
        actions={
          <Tooltip delay={300}>
            <Tooltip.Trigger className="rounded-md">
              <KbdHint keys={['T']} />
            </Tooltip.Trigger>
            <Tooltip.Content className="text-xs">{t('live.type.focusShortcut')}</Tooltip.Content>
          </Tooltip>
        }
      >
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void typeText();
          }}
        >
          <TextField value={text} onChange={setText} isDisabled={Boolean(reason)} className="min-w-0 flex-1" aria-label={t('live.type.label')}>
            <Input ref={typeFieldRef} variant="secondary" placeholder={t('live.type.placeholder')} maxLength={2000} autoComplete="off" spellCheck={false} />
          </TextField>
          <Button type="submit" size="sm" variant="primary" className="h-9" isDisabled={Boolean(reason) || !text} isPending={pending === 'type'}>
            <PaperPlane className="size-3.5 rtl:-scale-x-100" />
            {t('live.type.send')}
          </Button>
        </form>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('live.keys.title')}>
          {KEYS.map((k) => (
            <IconButton
              key={k.key}
              label={t(k.labelKey)}
              icon={<span className="flex items-center text-xs [&>svg]:size-3.5">{k.display}</span>}
              variant="secondary"
              size="sm"
              isDisabled={Boolean(reason)}
              disabledReason={reason}
              isPending={pending === `key-${k.key}`}
              onPress={() => void send(`key-${k.key}`, { kind: 'press_key', key: k.key })}
              className="h-8 min-w-9 rounded-lg px-2"
            />
          ))}
        </div>
      </Section>
    </div>
  );
}
