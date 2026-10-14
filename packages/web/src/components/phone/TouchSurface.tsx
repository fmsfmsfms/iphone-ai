// Pointer layer over the screenshot that turns clicks and drags into device
// actions: a click is a tap (or long-press / double-tap, per the mode), a
// drag beyond 8 px released within 600 ms is a swipe, slower ones are drags.

import type { DeviceAction, FrameMeta } from '@iphone-ai/shared';
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import { classifyGesture, distance, pointerToWindowPoint, type WindowPoint } from '../../lib/geometry';
import { useI18n } from '../../lib/i18n';
import { sendManualAction } from './phone-actions';

export type TouchMode = 'tap' | 'long_press' | 'double_tap';

export interface TouchSurfaceProps {
  imageRef: RefObject<HTMLImageElement | null>;
  meta: FrameMeta;
  natural: { width: number; height: number };
  mode: TouchMode;
  onSent?: (result: { focusChanged: boolean } | null) => void;
}

interface Gesture {
  pointerId: number;
  startClient: { x: number; y: number };
  lastClient: { x: number; y: number };
  startPoint: WindowPoint;
  startTime: number;
  moved: boolean;
}

interface Ripple {
  id: number;
  x: number;
  y: number;
  long: boolean;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));

let rippleSeq = 0;

export function TouchSurface({ imageRef, meta, natural, mode, onSent }: TouchSurfaceProps) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [trail, setTrail] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [sending, setSending] = useState(false);

  const geometry = meta.geometry;
  const pxPerPt = meta.pxPerPt;

  const toLocal = (clientX: number, clientY: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: 0, y: 0 };
  };

  const map = (clientX: number, clientY: number, clampToImage: boolean): WindowPoint | null => {
    const img = imageRef.current;
    if (!img || !geometry || !pxPerPt) return null;
    const rect = img.getBoundingClientRect();
    return pointerToWindowPoint({
      clientX,
      clientY,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      natural,
      pxPerPt,
      windowPt: { width: geometry.widthPt, height: geometry.heightPt },
      clamp: clampToImage,
    });
  };

  const addRipple = (clientX: number, clientY: number, long: boolean) => {
    const local = toLocal(clientX, clientY);
    rippleSeq += 1;
    const ripple: Ripple = { id: rippleSeq, x: local.x, y: local.y, long };
    setRipples((list) => [...list.slice(-4), ripple]);
    setTimeout(() => setRipples((list) => list.filter((r) => r.id !== ripple.id)), long ? 950 : 500);
  };

  const send = async (action: DeviceAction) => {
    setSending(true);
    try {
      const result = await sendManualAction(action, { geometryId: geometry?.geometryId ?? null, frameSeq: meta.seq });
      onSent?.(result);
    } finally {
      setSending(false);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || sending || gesture.current) return;
    const point = map(e.clientX, e.clientY, false);
    if (!point) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = {
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      lastClient: { x: e.clientX, y: e.clientY },
      startPoint: point,
      startTime: performance.now(),
      moved: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    g.lastClient = { x: e.clientX, y: e.clientY };
    if (!g.moved && distance(g.startClient, g.lastClient) > 8) g.moved = true;
    if (g.moved) setTrail({ from: toLocal(g.startClient.x, g.startClient.y), to: toLocal(e.clientX, e.clientY) });
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    setTrail(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (cancelled) return;

    const elapsed = performance.now() - g.startTime;
    const travel = distance(g.startClient, { x: e.clientX, y: e.clientY });
    const kind = classifyGesture(travel, elapsed);
    const { startPoint: from } = g;

    if (kind === 'tap') {
      addRipple(g.startClient.x, g.startClient.y, mode === 'long_press');
      if (mode === 'long_press') {
        void send({ kind: 'long_press', x: from.x, y: from.y, durationMs: clamp(elapsed, 500, 3000) });
      } else if (mode === 'double_tap') {
        void send({ kind: 'double_tap', x: from.x, y: from.y });
      } else {
        void send({ kind: 'tap', x: from.x, y: from.y });
      }
      return;
    }

    const to = map(e.clientX, e.clientY, true);
    if (!to) return;
    addRipple(e.clientX, e.clientY, false);
    if (kind === 'swipe') {
      void send({ kind: 'swipe', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: clamp(elapsed, 100, 1000) });
    } else {
      void send({ kind: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, durationMs: clamp(elapsed, 300, 5000) });
    }
  };

  return (
    <div
      ref={surfaceRef}
      className={['absolute inset-0 touch-none select-none', sending ? 'cursor-progress' : 'cursor-crosshair'].join(' ')}
      role="application"
      aria-label={t('viewer.touch.surfaceLabel')}
      aria-busy={sending}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {trail ? (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          <line
            x1={trail.from.x}
            y1={trail.from.y}
            x2={trail.to.x}
            y2={trail.to.y}
            stroke="rgb(10 132 255 / 0.85)"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <circle cx={trail.from.x} cy={trail.from.y} r={8} fill="rgb(10 132 255 / 0.35)" stroke="white" strokeWidth={2} />
        </svg>
      ) : null}
      {ripples.map((r) => (
        <span key={r.id} className={`touch-ripple ${r.long ? 'touch-ripple--long' : ''}`} style={{ left: r.x, top: r.y }} />
      ))}
      {sending ? (
        <span className="pointer-events-none absolute top-2 start-1/2 -translate-x-1/2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white rtl:translate-x-1/2">
          {t('viewer.touch.sending')}
        </span>
      ) : null}
    </div>
  );
}
