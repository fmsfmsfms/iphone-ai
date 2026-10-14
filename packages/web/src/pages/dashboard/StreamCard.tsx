// Honest screen-update statistics: which mode the backend is in (live
// ScreenCaptureKit frames or polled Mirroir screenshots), whether live capture
// is available (and why not), and the polling numbers.

import { Picture } from '@gravity-ui/icons';

import { KeyValueList } from '../../components/KeyValue';
import { Panel } from '../../components/Panel';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { liveErrorText } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { useSettings, useStream } from '../../state/store';

export function StreamCard() {
  const { t, formatNumber } = useI18n();
  const stream = useStream();
  const settings = useSettings();
  const isLive = stream?.mode === 'live-screencapturekit';
  const liveCaptureOn = settings?.connection.screenshot.liveCapture ?? true;
  const fps = (v: number) => t('dashboard.stream.fps', { value: formatNumber(v, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) });

  return (
    <Panel icon={<Picture />} title={t('dashboard.stream.title')} description={isLive ? t('dashboard.stream.descriptionLive') : t('dashboard.stream.description')}>
      {stream ? (
        <KeyValueList
          dense
          items={[
            { label: t('dashboard.stream.mode'), value: isLive ? t('dashboard.stream.modeLive') : t('dashboard.stream.modeValue') },
            {
              label: t('dashboard.stream.liveCapture'),
              value: !liveCaptureOn ? (
                <StatusChip tone="default" size="sm" label={t('dashboard.stream.liveOff')} />
              ) : stream.liveAvailable ? (
                <StatusChip tone="success" size="sm" label={t('dashboard.stream.liveAvailable')} />
              ) : (
                <StatusChip tone="warning" size="sm" label={t('dashboard.stream.liveUnavailable')} />
              ),
              hint: liveCaptureOn && stream.liveError ? <span className="text-warning">{liveErrorText(stream.liveError, t)}</span> : undefined,
            },
            {
              label: t('dashboard.stream.state'),
              value: stream.running ? (
                <StatusChip tone="success" size="sm" label={t('dashboard.stream.running')} />
              ) : (
                <StatusChip tone="default" size="sm" label={t('dashboard.stream.paused')} />
              ),
              hint: !stream.running && stream.pausedReason ? stream.pausedReason : undefined,
            },
            { label: t('dashboard.stream.target'), value: fps(stream.targetFps) },
            { label: t('dashboard.stream.measured'), value: fps(stream.measuredFps) },
            { label: t('dashboard.stream.latency'), value: t('dashboard.stream.ms', { value: formatNumber(Math.round(stream.avgLatencyMs)) }) },
            { label: t('dashboard.stream.lastFrame'), value: <RelativeTime at={stream.lastFrameAt} /> },
            { label: t('dashboard.stream.viewers'), value: formatNumber(stream.viewers) },
            ...(stream.consecutiveErrors > 0
              ? [{ label: t('dashboard.stream.errors'), value: <span className="text-warning">{formatNumber(stream.consecutiveErrors)}</span> }]
              : []),
            ...(stream.lastError ? [{ label: t('dashboard.stream.lastError'), value: <span className="text-danger">{stream.lastError}</span> }] : []),
          ]}
        />
      ) : (
        <p className="text-[13px] text-muted">{t('dashboard.stream.unavailable')}</p>
      )}
    </Panel>
  );
}
