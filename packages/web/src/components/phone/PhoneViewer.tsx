// The phone screen: polled screenshots in a device frame that keeps the real
// aspect ratio (portrait or landscape), double-buffered so frames swap without
// flicker, with honest stream numbers and — when manual control is allowed —
// click / drag input mapped to Mirroir window points.

import {
  ArrowDownToLine,
  ArrowUpRightFromSquare,
  ArrowsExpand,
  ArrowsRotateRight,
  CircleInfo,
  Hand,
  LockFill,
  OctagonXmark,
} from '@gravity-ui/icons';
import { Button, Modal, ToggleButton, ToggleButtonGroup, Tooltip } from '@heroui/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';

import { touchAvailability } from '../../lib/device-state';
import { useLatestFrame, type LoadedFrame } from '../../lib/frames';
import { fitAspect } from '../../lib/geometry';
import { useI18n } from '../../lib/i18n';
import { readJson, STORAGE_KEYS, writeJson } from '../../lib/storage';
import {
  registerViewer,
  useActiveRun,
  useActiveTask,
  useAppStore,
  useCanControl,
} from '../../state/store';
import { IconButton } from '../IconButton';
import { RelativeTime, useNow } from '../RelativeTime';
import { StatusChip } from '../StatusChip';
import { openMirroring, useScreenRefresh } from './phone-actions';
import { TouchSurface, type TouchMode } from './TouchSurface';
import { viewerBlock, ViewerOverlay } from './ViewerOverlay';

export interface PhoneViewerProps {
  /** Allow touch input when manual control conditions are met (Live Control). */
  interactive?: boolean;
  /** Show the toolbar (refresh, download, enlarge, open mirroring, touch mode). */
  toolbar?: boolean;
  /** `compact` is the small read-only dashboard preview. */
  variant?: 'full' | 'compact';
  /** Show the enlarge button (off inside the enlarged view itself). */
  allowEnlarge?: boolean;
  className?: string;
}

const STALE_AFTER_MS = 5000;
const DEFAULT_ASPECT = 0.462; // typical iPhone Mirroring portrait window
const FOCUS_NOTICE_MS = 10_000;

function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) => (Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5 ? prev : { width: rect.width, height: rect.height }));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

type Layers = { a: LoadedFrame | null; b: LoadedFrame | null; front: 'a' | 'b' };

/** Two stacked <img> layers: the new frame loads in the back layer and is shown once decoded. */
function useDoubleBuffer(latest: LoadedFrame | null) {
  const [layers, setLayers] = useState<Layers>(() => ({ a: latest, b: null, front: 'a' }));
  useEffect(() => {
    if (!latest) return;
    setLayers((prev) => {
      if (prev[prev.front] === latest) return prev;
      const back = prev.front === 'a' ? 'b' : 'a';
      if (prev[back] === latest) return prev;
      return { ...prev, [back]: latest };
    });
  }, [latest]);
  const onLoad = (layer: 'a' | 'b') => {
    setLayers((prev) => {
      const candidate = prev[layer];
      if (!candidate || prev.front === layer) return prev;
      const shown = prev[prev.front];
      // loadedAt is monotonic even when the backend's frame sequence restarts.
      if (shown && shown.loadedAt >= candidate.loadedAt) return prev;
      return { ...prev, front: layer };
    });
  };
  return { layers, front: layers[layers.front], onLoad };
}

export function PhoneViewer({ interactive = false, toolbar = true, variant = 'full', allowEnlarge = true, className }: PhoneViewerProps) {
  const { t, formatNumber } = useI18n();
  const compact = variant === 'compact';
  const status = useAppStore((s) => s.status);
  const settings = useAppStore((s) => s.settings);
  const session = useAppStore((s) => s.session);
  const stream = useAppStore((s) => s.stream);
  const announced = useAppStore((s) => s.frame);
  const stop = useAppStore((s) => s.stop);
  const focusToastAt = useAppStore((s) => s.ui.focusStealAcknowledgedAt);
  const activeTask = useActiveTask();
  const activeRun = useActiveRun();
  const canControl = useCanControl();
  const latest = useLatestFrame();
  const { layers, front, onLoad } = useDoubleBuffer(latest);
  const imgA = useRef<HTMLImageElement>(null);
  const imgB = useRef<HTMLImageElement>(null);
  const [areaRef, area] = useElementSize<HTMLDivElement>();
  const [enlarged, setEnlarged] = useState(false);
  const [mode, setMode] = useState<TouchMode>(() => {
    const saved = readJson<string>(STORAGE_KEYS.touchMode, 'tap');
    return saved === 'long_press' || saved === 'double_tap' ? saved : 'tap';
  });
  const { refresh, refreshing } = useScreenRefresh();
  const [opening, setOpening] = useState(false);
  const now = useNow(1000);

  useEffect(() => registerViewer(), []);
  useEffect(() => writeJson(STORAGE_KEYS.touchMode, mode), [mode]);

  // Meta for the displayed image: prefer the announcement matching its seq.
  const meta = front?.meta ?? (announced && front && announced.seq === front.seq ? announced : null);
  const natural = front ? { width: front.naturalWidth, height: front.naturalHeight } : null;

  const aspect = useMemo(() => {
    if (natural && natural.width > 0 && natural.height > 0) return natural.width / natural.height;
    if (announced && announced.widthPx > 0 && announced.heightPx > 0) return announced.widthPx / announced.heightPx;
    const g = status?.mirroring.geometry;
    if (g && g.widthPt > 0 && g.heightPt > 0) return g.widthPt / g.heightPt;
    return DEFAULT_ASPECT;
  }, [natural?.width, natural?.height, announced, status?.mirroring.geometry]);

  const block = viewerBlock(status, stream, Boolean(front));
  const touch = touchAvailability({ status, settings, session, activeTask, activeRun }, meta, natural);
  const touchEnabled = interactive && canControl && !block && touch.allowed && Boolean(meta && natural);

  // Device frame sizing: bezel thickness scales with the available space.
  const shortSide = Math.min(area.width, area.height);
  const bezel = compact ? Math.max(5, Math.min(9, shortSide * 0.025)) : Math.max(7, Math.min(14, shortSide * 0.022));
  const screen = fitAspect({ width: Math.max(0, area.width - bezel * 2 - 4), height: Math.max(0, area.height - bezel * 2 - 4) }, aspect);
  const screenRadius = Math.min(screen.width, screen.height) * 0.11;
  const frameStyle: CSSProperties = {
    width: screen.width + bezel * 2,
    height: screen.height + bezel * 2,
    padding: bezel,
    borderRadius: screenRadius + bezel,
  };

  // Client clock (when this UI received the frame): immune to clock skew on remote viewers.
  const lastFrameAt = front?.loadedAt ?? null;
  const stale = Boolean(!block && stream?.running && lastFrameAt && now - lastFrameAt > STALE_AFTER_MS);
  const lastFocusSteal = status?.lastFocusSteal ?? null;
  const showFocusChip = Boolean(
    interactive && lastFocusSteal && now - lastFocusSteal < FOCUS_NOTICE_MS && focusToastAt !== lastFocusSteal,
  );

  const download = () => {
    if (!front) return;
    const a = document.createElement('a');
    a.href = front.url;
    const stamp = new Date(front.meta?.capturedAt ?? front.loadedAt).toISOString().replace(/[:.]/g, '-');
    a.download = `iphone-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const open = async () => {
    setOpening(true);
    try {
      await openMirroring();
    } finally {
      setOpening(false);
    }
  };

  const frontRef = layers.front === 'a' ? imgA : imgB;

  return (
    <div className={['flex h-full min-h-0 w-full flex-col', className ?? ''].join(' ')}>
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
          {interactive ? (
            <>
              <ToggleButtonGroup
                aria-label={t('viewer.mode.label')}
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[mode]}
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  if (next === 'tap' || next === 'long_press' || next === 'double_tap') setMode(next);
                }}
                size="sm"
                isDisabled={!touchEnabled}
              >
                <ToggleButton id="tap">{t('viewer.mode.tap')}</ToggleButton>
                <ToggleButton id="long_press">
                  <ToggleButtonGroup.Separator />
                  {t('viewer.mode.longPress')}
                </ToggleButton>
                <ToggleButton id="double_tap">
                  <ToggleButtonGroup.Separator />
                  {t('viewer.mode.doubleTap')}
                </ToggleButton>
              </ToggleButtonGroup>
              {touchEnabled ? (
                <StatusChip tone="accent" size="sm" icon={<Hand />} hideDot label={t('viewer.touch.enabled')} tooltip={t('viewer.touch.enabledHint')} />
              ) : (
                <StatusChip
                  tone="default"
                  size="sm"
                  icon={<LockFill />}
                  hideDot
                  label={t('viewer.touch.viewOnly')}
                  tooltip={!canControl ? t('input.reason.viewOnly') : block ? t('viewer.touch.blocked') : touch.reasonKey ? t(touch.reasonKey) : t('viewer.touch.blocked')}
                />
              )}
            </>
          ) : (
            <StatusChip tone="default" size="sm" icon={<LockFill />} hideDot label={t('viewer.readOnly')} />
          )}
          {showFocusChip ? (
            <StatusChip tone="warning" size="sm" icon={<CircleInfo />} hideDot label={t('viewer.focus.chip')} tooltip={t('viewer.focus.body')} />
          ) : null}
          <div className="ms-auto flex items-center gap-0.5">
            <IconButton
              label={t('viewer.refresh')}
              icon={<ArrowsRotateRight />}
              shortcut={interactive ? ['R'] : undefined}
              onPress={() => void refresh()}
              isPending={refreshing}
              isDisabled={!canControl || Boolean(block && block.kind !== 'waiting')}
              disabledReason={!canControl ? t('input.reason.viewOnly') : t('viewer.refreshUnavailable')}
            />
            <IconButton
              label={t('viewer.download')}
              icon={<ArrowDownToLine />}
              onPress={download}
              isDisabled={!front}
              disabledReason={t('viewer.noFrameYet')}
            />
            {allowEnlarge ? (
              <IconButton label={t('viewer.enlarge')} icon={<ArrowsExpand />} onPress={() => setEnlarged(true)} />
            ) : null}
            <IconButton
              label={t('viewer.openMirroring')}
              icon={<ArrowUpRightFromSquare />}
              onPress={() => void open()}
              isPending={opening}
              isDisabled={!canControl}
              disabledReason={t('input.reason.viewOnly')}
            />
          </div>
        </div>
      ) : null}

      <div ref={areaRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {screen.width > 0 ? (
          <div className="phone-bezel app-transition" style={frameStyle}>
            <div
              className="phone-screen h-full w-full"
              style={{ borderRadius: screenRadius }}
              data-touch-enabled={touchEnabled || undefined}
            >
              {(['a', 'b'] as const).map((layer) => {
                const frame = layers[layer];
                if (!frame) return null;
                const isFront = layers.front === layer;
                return (
                  <img
                    key={layer}
                    ref={layer === 'a' ? imgA : imgB}
                    src={frame.url}
                    alt={isFront ? t('viewer.imageAlt') : ''}
                    aria-hidden={!isFront}
                    draggable={false}
                    onLoad={() => onLoad(layer)}
                    className={[
                      'absolute inset-0 h-full w-full object-contain',
                      isFront ? (block ? 'opacity-25 blur-sm' : 'opacity-100') : 'opacity-0',
                    ].join(' ')}
                  />
                );
              })}

              {touchEnabled && meta && natural ? (
                <TouchSurface imageRef={frontRef} meta={meta} natural={natural} mode={mode} />
              ) : null}

              {block ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
                  <ViewerOverlay block={block} compact={compact} canControl={canControl} />
                </div>
              ) : null}

              {stop.latched && !block ? (
                <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-center">
                  <span className="flex items-center gap-1.5 rounded-full bg-danger/90 px-3 py-1 text-[11px] font-medium text-white shadow-lg">
                    <OctagonXmark className="size-3.5" />
                    {t('viewer.stopped')}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className={['flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-2 text-center text-muted', compact ? 'pt-2 text-[11px]' : 'pt-3 text-xs'].join(' ')}>
        <span className="tabular-nums">
          {stream?.running
            ? t('viewer.stats.polling', {
                fps: formatNumber(stream.measuredFps, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
                latency: formatNumber(Math.round(stream.avgLatencyMs)),
              })
            : stream?.pausedReason
              ? t('viewer.stats.paused', { reason: stream.pausedReason })
              : t('viewer.stats.idle')}
        </span>
        {lastFrameAt ? (
          <span>
            · {t('viewer.stats.updated')} <RelativeTime at={lastFrameAt} />
          </span>
        ) : null}
        {stale ? <StatusChip tone="warning" size="sm" label={t('viewer.stale')} tooltip={t('viewer.staleHint')} /> : null}
        {!compact && touchEnabled ? <span className="hidden text-muted/80 lg:inline">· {t('viewer.touch.hint')}</span> : null}
      </div>

      {allowEnlarge ? (
        <Modal.Backdrop isOpen={enlarged} onOpenChange={setEnlarged} variant="blur">
          <Modal.Container size="full" placement="center">
            <Modal.Dialog className="flex h-full flex-col gap-0 bg-background/95 p-0" aria-label={t('viewer.enlargedTitle')}>
              <Modal.Header className="flex flex-row items-center gap-3 border-b border-hairline px-5 py-3">
                <Modal.Heading className="flex-1 text-[15px] font-semibold">{t('viewer.enlargedTitle')}</Modal.Heading>
                <Tooltip delay={400}>
                  <Button variant="secondary" size="sm" slot="close">
                    {t('common.close')}
                  </Button>
                  <Tooltip.Content className="text-xs">{t('viewer.closeHint')}</Tooltip.Content>
                </Tooltip>
              </Modal.Header>
              <Modal.Body className="flex min-h-0 flex-1 flex-col p-5">
                {enlarged ? <PhoneViewer interactive={interactive} toolbar allowEnlarge={false} /> : null}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : null}
    </div>
  );
}
