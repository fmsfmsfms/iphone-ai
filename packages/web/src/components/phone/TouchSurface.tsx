// Pointer and keyboard layer over the phone picture that turns input into
// device actions: a click is a tap (or long-press / double-tap, per the mode);
// a drag is a Mirroir swipe with the user's own start/end points and duration
// (a click-drag in Long press mode; lib/gestures.ts). While the screen is
// focused, the arrow keys send centred swipes (↑ = next item).

import type { DeviceAction, FrameMeta } from '@iphone-ai/shared';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import { distance, pointerToWindowPoint, windowPointToElement, type WindowPoint } from '../../lib/geometry';
import { flickAction, flickDirectionForKey, pointerGestureAction, type TouchMode } from '../../lib/gestures';
import { useI18n } from '../../lib/i18n';
import { sendManualAction } from './phone-actions';

export type { TouchMode } from '../../lib/gestures';

export interface TouchSurfaceProps {
  /** The element showing the picture (screenshot <img> or live <canvas>); only its on-screen box is used. */
  imageRef: RefObject<HTMLElement | null>;
  meta: FrameMeta;
  natural: { width: number; height: number };
  mode: TouchMode;
  /** Arrow keys flick the screen while this surface has focus (Live Control). */
  keyboardFlicks?: boolean;
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

type Line = { from: { x: number; y: number }; to: { x: number; y: number } };

const FLICK_TRAIL_MS = 260;
const FLICK_KEYS = 'ArrowUp ArrowDown ArrowLeft ArrowRight';

let rippleSeq = 0;

export function TouchSurface({ imageRef, meta, natural, mode, keyboardFlicks = false, onSent }: TouchSurfaceProps) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const busy = useRef(false);
  const flickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trail, setTrail] = useState<Line | null>(null);
  const [flick, setFlick] = useState<Line | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const hintId = useId();

  const geometry = meta.geometry;
  const pxPerPt = meta.pxPerPt;

  useEffect(
    () => () => {
      if (flickTimer.current) clearTimeout(flickTimer.current);
    },
    [],
  );

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

  /** Window point → position inside this surface (for drawing feedback). */
  const toSurface = (point: WindowPoint) => {
    const img = imageRef.current;
    if (!img || !pxPerPt) return null;
    const rect = img.getBoundingClientRect();
    const pos = windowPointToElement(point, { width: rect.width, height: rect.height }, natural, pxPerPt);
    if (!pos) return null;
    return toLocal(rect.left + pos.x, rect.top + pos.y);
  };

  const addRipple = (local: { x: number; y: number }, long: boolean) => {
    rippleSeq += 1;
    const ripple: Ripple = { id: rippleSeq, x: local.x, y: local.y, long };
    setRipples((list) => [...list.slice(-4), ripple]);
    setTimeout(() => setRipples((list) => list.filter((r) => r.id !== ripple.id)), long ? 950 : 500);
  };

  const send = async (action: DeviceAction) => {
    busy.current = true;
    setSending(true);
    try {
      const result = await sendManualAction(action, { geometryId: geometry?.geometryId ?? null, frameSeq: meta.seq });
      onSent?.(result);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || busy.current || gesture.current) return;
    const point = map(e.clientX, e.clientY, false);
    if (!point) return;
    e.preventDefault();
    if (keyboardFlicks) e.currentTarget.focus({ preventScroll: true });
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

    const travelPx = distance(g.startClient, { x: e.clientX, y: e.clientY });
    const action = pointerGestureAction({
      mode,
      from: g.startPoint,
      to: map(e.clientX, e.clientY, true),
      travelPx,
      elapsedMs: performance.now() - g.startTime,
    });
    if (!action) return;
    if (action.kind === 'swipe' || action.kind === 'drag') addRipple(toLocal(e.clientX, e.clientY), false);
    else addRipple(toLocal(g.startClient.x, g.startClient.y), action.kind === 'long_press');
    void send(action);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!keyboardFlicks || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const direction = flickDirectionForKey(e.key);
    if (!direction) return;
    // Arrow keys never scroll the page while the phone screen has focus.
    e.preventDefault();
    if (e.repeat || busy.current || gesture.current) return;
    const action = flickAction(direction, geometry ? { width: geometry.widthPt, height: geometry.heightPt } : null);
    if (!action || action.kind !== 'swipe') return;
    const from = toSurface({ x: action.fromX, y: action.fromY });
    const to = toSurface({ x: action.toX, y: action.toY });
    if (from && to) {
      setFlick({ from, to });
      addRipple(to, false);
      if (flickTimer.current) clearTimeout(flickTimer.current);
      flickTimer.current = setTimeout(() => setFlick(null), FLICK_TRAIL_MS);
    }
    void send(action);
  };

  const line = trail ?? flick;

  return (
    <div
      ref={surfaceRef}
      className={[
        'absolute inset-0 touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
        sending ? 'cursor-progress' : 'cursor-crosshair',
      ].join(' ')}
      role="application"
      aria-label={t('viewer.touch.surfaceLabel')}
      aria-describedby={keyboardFlicks ? hintId : undefined}
      aria-keyshortcuts={keyboardFlicks ? FLICK_KEYS : undefined}
      aria-busy={sending}
      tabIndex={keyboardFlicks ? 0 : undefined}
      data-touch-surface=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {line ? (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          <line
            x1={line.from.x}
            y1={line.from.y}
            x2={line.to.x}
            y2={line.to.y}
            stroke="rgb(10 132 255 / 0.85)"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <circle cx={line.from.x} cy={line.from.y} r={8} fill="rgb(10 132 255 / 0.35)" stroke="white" strokeWidth={2} />
        </svg>
      ) : null}
      {ripples.map((r) => (
        <span key={r.id} className={`touch-ripple ${r.long ? 'touch-ripple--long' : ''}`} style={{ left: r.x, top: r.y }} />
      ))}
      {keyboardFlicks ? (
        <span id={hintId} className="sr-only">
          {t('viewer.flick.description')}
        </span>
      ) : null}
      {sending ? (
        <span className="pointer-events-none absolute top-2 start-1/2 -translate-x-1/2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white rtl:translate-x-1/2">
          {t('viewer.touch.sending')}
        </span>
      ) : keyboardFlicks && focused ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-3 start-1/2 -translate-x-1/2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] whitespace-nowrap text-white rtl:translate-x-1/2"
        >
          {t('viewer.flick.focusedHint')}
        </span>
      ) : null}
    </div>
  );
}
