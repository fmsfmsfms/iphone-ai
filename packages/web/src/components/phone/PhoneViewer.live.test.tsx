// The live viewer: ScreenCaptureKit frames on a canvas with an honest status
// line, fallback to polled screenshots, finger-like drags and arrow-key flicks
// mapped through the displayed frame's own geometry.

import type { FrameMeta } from '@iphone-ai/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShortcutsDialog } from '../../app/ShortcutsDialog';
import type { LoadedFrame } from '../../lib/frames';
import { liveScreen, type DecodedImage } from '../../lib/live-screen';
import { appStore, reduceBootstrap, resetStoreForTests } from '../../state/store';
import { calledRoutes, jsonResponse, routeFetch } from '../../test/http';
import { encodeScreenMessage, makeBootstrap, makeFrame, makeLiveHeader, makeSettings, makeStream } from '../../test/fixtures';
import { PhoneViewer } from './PhoneViewer';

// Polled screenshots come from lib/frames (fetch + <img> decode in the app); here a tiny store stands in.
const polled = vi.hoisted(() => {
  let frame: unknown = null;
  const listeners = new Set<() => void>();
  return {
    get: () => frame,
    set(next: unknown) {
      frame = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock('../../lib/frames', async () => {
  const { useSyncExternalStore } = await import('react');
  return { useLatestFrame: () => useSyncExternalStore(polled.subscribe, polled.get, polled.get) };
});

function polledFrame(meta: FrameMeta): LoadedFrame {
  return { url: `blob:polled-${meta.seq}`, seq: meta.seq, meta, naturalWidth: 820, naturalHeight: 1780, loadedAt: Date.now(), blob: new Blob() };
}

const SURFACE = { name: 'iPhone screen — click to tap, drag to swipe' };
const drawImage = vi.fn();
const originalRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  // Every element is 410 × 890 CSS px at the origin: the 2× frame (820 × 1780 px) maps 1 CSS px → 1 pt.
  Element.prototype.getBoundingClientRect = function rect() {
    return { left: 0, top: 0, right: 410, bottom: 890, width: 410, height: 890, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto['setPointerCapture'] = () => undefined;
  proto['releasePointerCapture'] = () => undefined;
  proto['hasPointerCapture'] = () => false;
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  const proto = Element.prototype as unknown as Record<string, unknown>;
  delete proto['setPointerCapture'];
  delete proto['releasePointerCapture'];
  delete proto['hasPointerCapture'];
});

let clock = 1_000;

beforeEach(() => {
  resetStoreForTests();
  liveScreen.reset();
  polled.set(null);
  drawImage.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage }) as unknown as CanvasRenderingContext2D);
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  liveScreen.configure({
    decode: async (): Promise<DecodedImage> => ({ image: {} as CanvasImageSource, width: 820, height: 1780, release: () => undefined }),
  });
  boot({ manual: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  liveScreen.reset();
  resetStoreForTests();
});

function boot({ manual }: { manual: boolean }) {
  act(() =>
    appStore.setState((s) =>
      reduceBootstrap(
        s,
        makeBootstrap({
          settings: makeSettings((x) => (x.permissions.manualControlEnabled = manual)),
          stream: makeStream({ liveAvailable: true }),
        }),
      ),
    ),
  );
}

async function deliver(seq: number, overrides: Record<string, unknown> = {}) {
  await act(async () => {
    liveScreen.receive(encodeScreenMessage(makeLiveHeader(seq, overrides)));
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

const stats = () => screen.getByTestId('viewer-stats').textContent;
const source = () => document.querySelector('.phone-screen')?.getAttribute('data-frame-source');

function actionRoute() {
  const bodies: unknown[] = [];
  const fetch = routeFetch({
    'POST /api/control/action': (init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(200, { ok: true, tool: 'drag', durationMs: 210, message: 'ok', focusChanged: false });
    },
  });
  return { bodies, fetch };
}

describe('honest status line', () => {
  it('says Live · ScreenCaptureKit only while live frames arrive, then falls back to the polling numbers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(100_000);
    polled.set(polledFrame(makeFrame(5, { capturedAt: 50_000 })));
    render(<PhoneViewer interactive toolbar />);
    expect(stats()).toBe('Polling · 1.9 fps · 210 ms');
    expect(source()).toBe('polled');
    expect(screen.getByRole('img', { name: 'Screenshot of your iPhone screen' }).tagName).toBe('IMG');

    // 20 fps of live frames, 30 ms from capture to display on this Mac.
    for (let i = 0; i < 20; i += 1) {
      await deliver(10 + i, { capturedAt: Date.now() - 30, receivedAt: Date.now() - 25 });
      act(() => vi.advanceTimersByTime(50));
    }
    act(() => vi.advanceTimersByTime(200));
    const label = stats() ?? '';
    const match = /^Live · ScreenCaptureKit · (\d+) fps · 30 ms$/.exec(label);
    expect(match, label).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(15);
    expect(Number(match![1])).toBeLessThanOrEqual(21);
    expect(source()).toBe('live');
    expect(screen.getByRole('img', { name: 'Screenshot of your iPhone screen' }).tagName).toBe('CANVAS');
    expect(drawImage).toHaveBeenCalledTimes(20);

    // No live frame for 2 s: the label is the polling one again. The last live frame is newer
    // than the last screenshot, so it stays on screen rather than jumping back in time.
    act(() => vi.advanceTimersByTime(2000));
    expect(stats()).toBe('Polling · 1.9 fps · 210 ms');
    expect(source()).toBe('live');

    // Polling resumes: a newer screenshot replaces the live picture.
    act(() => polled.set(polledFrame(makeFrame(40, { capturedAt: Date.now() }))));
    const images = document.querySelectorAll('.phone-screen img');
    act(() => images.forEach((img) => fireEvent.load(img)));
    expect(source()).toBe('polled');
    expect(screen.getByRole('img', { name: 'Screenshot of your iPhone screen' }).tagName).toBe('IMG');
  });

  it('shows the live picture when it is the only frame, with its own scale on the device panel', async () => {
    render(<PhoneViewer interactive toolbar />);
    expect(screen.getByText('Waiting for the first screenshot…')).toBeInTheDocument();
    await deliver(1);
    expect(source()).toBe('live');
    expect(stats()).toMatch(/^Live · ScreenCaptureKit · /);
    expect(screen.queryByText('Waiting for the first screenshot…')).toBeNull();
  });
});

describe('drag gestures', () => {
  it('a drag that stops before release replays the real start/end points at 460 pt/s (no momentum)', async () => {
    const { bodies } = actionRoute();
    render(<PhoneViewer interactive toolbar />);
    await deliver(42);
    const surface = screen.getByRole('application', SURFACE);

    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 205, clientY: 600 });
    clock = 1_120;
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 205, clientY: 450 });
    clock = 1_250;
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 205, clientY: 300 });
    // Held still before release.
    clock = 1_600;
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 205, clientY: 300 });

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      action: { kind: 'swipe', fromX: 205, fromY: 600, toX: 205, toY: 300, durationMs: 653 },
      geometryId: '410x890',
      frameSeq: 42,
    });
  });

  it('a flick (released while moving) pages with the long swipe; a slow drag keeps its own points', async () => {
    const { bodies } = actionRoute();
    render(<PhoneViewer interactive toolbar />);
    await deliver(1);
    const surface = screen.getByRole('application', SURFACE);

    // Quick flick up: the long page swipe, centred (70% of the screen at 460 pt/s).
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 100, clientY: 700 });
    clock += 15;
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 110, clientY: 200 });
    await waitFor(() => expect(bodies).toHaveLength(1));

    // A drag still moving at release, but slowly (0.1 pt/ms): the user's own points.
    fireEvent.pointerDown(surface, { pointerId: 2, button: 0, clientX: 300, clientY: 200 });
    clock += 6_000;
    // Released outside the picture: the end point is clamped to the screen edge.
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 300, clientY: 2_000 });
    await waitFor(() => expect(bodies).toHaveLength(2));

    // A flick down while moving fast at release, after a slow start.
    fireEvent.pointerDown(surface, { pointerId: 3, button: 0, clientX: 200, clientY: 300 });
    clock += 500;
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 200, clientY: 330 });
    clock += 40;
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 200, clientY: 400 });
    clock += 40;
    fireEvent.pointerUp(surface, { pointerId: 3, clientX: 200, clientY: 470 });
    await waitFor(() => expect(bodies).toHaveLength(3));

    expect(bodies.map((b) => (b as { action: unknown }).action)).toEqual([
      { kind: 'swipe', fromX: 205, fromY: 757, toX: 205, toY: 134, durationMs: 1355 },
      { kind: 'swipe', fromX: 300, fromY: 200, toX: 300, toY: 890, durationMs: 1500 },
      { kind: 'swipe', fromX: 205, fromY: 134, toX: 205, toY: 757, durationMs: 1355 },
    ]);
  });

  it('a click is still a tap', async () => {
    const { bodies } = actionRoute();
    render(<PhoneViewer interactive toolbar />);
    await deliver(3);
    const surface = screen.getByRole('application', SURFACE);
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 50.25, clientY: 80 });
    clock += 90;
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 53, clientY: 82 });
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ action: { kind: 'tap', x: 50.3, y: 80 }, frameSeq: 3 });
  });

  it('uses the live frame’s own scale (a downscaled frame maps to the same window points)', async () => {
    const { bodies } = actionRoute();
    liveScreen.configure({
      decode: async (): Promise<DecodedImage> => ({ image: {} as CanvasImageSource, width: 737, height: 1600, release: () => undefined }),
    });
    render(<PhoneViewer interactive toolbar />);
    // 1600 px long edge: 890 pt × 1.7978 px/pt.
    await deliver(9, { widthPx: 737, heightPx: 1600, pxPerPt: 1600 / 890 });
    const surface = screen.getByRole('application', SURFACE);
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 205, clientY: 445 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 205, clientY: 445 });
    await waitFor(() => expect(bodies).toHaveLength(1));
    const action = (bodies[0] as { action: { x: number; y: number } }).action;
    expect(action.x).toBeCloseTo(205, 0);
    expect(action.y).toBeCloseTo(445, 0);
  });

  it('keeps touches off with the usual explanation when the live frame has no geometry', async () => {
    const { fetch } = actionRoute();
    render(<PhoneViewer interactive toolbar />);
    await deliver(1, { geometry: null });
    expect(source()).toBe('live');
    expect(screen.queryByRole('application', SURFACE)).toBeNull();
    expect(screen.getByText('Touch off', { exact: true })).toBeInTheDocument();
    expect(calledRoutes(fetch)).toEqual([]);
  });
});

describe('keyboard flicks', () => {
  it('arrow keys page the focused screen with the long swipe: 70% of the screen, centred, at 460 pt/s', async () => {
    const { bodies } = actionRoute();
    render(<PhoneViewer interactive toolbar />);
    await deliver(7);
    const surface = screen.getByRole('application', SURFACE);
    expect(surface).toHaveAttribute('tabindex', '0');
    expect(surface).toHaveAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight');
    act(() => surface.focus());
    expect(screen.getByText('↑ ↓ ← → flick')).toBeInTheDocument();

    fireEvent.keyDown(surface, { key: 'ArrowUp' });
    await waitFor(() => expect(bodies).toHaveLength(1));
    // Modifier combos and auto-repeat are left alone.
    fireEvent.keyDown(surface, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(surface, { key: 'ArrowDown', metaKey: true });
    fireEvent.keyDown(surface, { key: 'ArrowDown', repeat: true });
    fireEvent.keyDown(surface, { key: 'ArrowLeft' });
    await waitFor(() => expect(bodies).toHaveLength(2));
    fireEvent.keyDown(surface, { key: 'ArrowDown' });
    await waitFor(() => expect(bodies).toHaveLength(3));

    expect(bodies).toEqual([
      { action: { kind: 'swipe', fromX: 205, fromY: 757, toX: 205, toY: 134, durationMs: 1355 }, geometryId: '410x890', frameSeq: 7 },
      { action: { kind: 'swipe', fromX: 349, fromY: 445, toX: 62, toY: 445, durationMs: 624 }, geometryId: '410x890', frameSeq: 7 },
      { action: { kind: 'swipe', fromX: 205, fromY: 134, toX: 205, toY: 757, durationMs: 1355 }, geometryId: '410x890', frameSeq: 7 },
    ]);
  });

  it('do nothing while manual control is off (no touch surface to focus)', async () => {
    boot({ manual: false });
    const { fetch } = actionRoute();
    render(<PhoneViewer interactive toolbar />);
    await deliver(7);
    expect(screen.queryByRole('application', SURFACE)).toBeNull();
    fireEvent.keyDown(document.querySelector('.phone-screen')!, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    await act(async () => Promise.resolve());
    expect(calledRoutes(fetch)).toEqual([]);
  });

  it('do nothing while the emergency stop is latched', async () => {
    const { fetch } = actionRoute();
    render(<PhoneViewer interactive toolbar />);
    await deliver(7);
    act(() => appStore.setState((s) => ({ status: s.status ? { ...s.status, stopLatched: true, stopReason: 'Test' } : s.status })));
    expect(screen.queryByRole('application', SURFACE)).toBeNull();
    expect(calledRoutes(fetch)).toEqual([]);
  });

  it('are listed in the shortcuts dialog', () => {
    render(<ShortcutsDialog isOpen onOpenChange={() => undefined} />);
    expect(screen.getByText('Flick up: next item (phone screen focused)')).toBeInTheDocument();
    expect(screen.getByText('Flick down: previous item')).toBeInTheDocument();
    expect(screen.getByText('Flick left or right')).toBeInTheDocument();
  });
});
