// Dashboard stream card and the Live Control device panel show the backend's
// stream mode and live-capture availability honestly.

import './messages';
import '../live/messages';

import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { liveScreen } from '../../lib/live-screen';
import { appStore, reduceBootstrap, resetStoreForTests } from '../../state/store';
import { makeBootstrap, makeSettings, makeStream } from '../../test/fixtures';
import { DevicePanel } from '../live/DevicePanel';
import type { useManualControl } from '../live/useManualControl';
import { StreamCard } from './StreamCard';

const manual = {
  enabled: false,
  canControl: true,
  isLocal: true,
  cannotTurnOn: false,
  pending: false,
  request: () => undefined,
  toggle: () => undefined,
  dialog: null,
} as unknown as ReturnType<typeof useManualControl>;

beforeEach(() => {
  resetStoreForTests();
  liveScreen.reset();
});

afterEach(() => {
  liveScreen.reset();
  resetStoreForTests();
});

function boot(stream = makeStream(), settings = makeSettings()) {
  act(() => appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ stream, settings }))));
}

describe('StreamCard', () => {
  it('shows polling with the reason live capture is unavailable', () => {
    boot(makeStream({ liveAvailable: false, liveError: 'Capture helper not installed' }));
    render(<StreamCard />);
    expect(screen.getByText('Polling screenshots')).toBeInTheDocument();
    expect(screen.getByText('Polling screenshots — not video.')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Capture helper not installed')).toBeInTheDocument();
  });

  it('shows the live mode while the backend receives live frames', () => {
    boot(makeStream({ mode: 'live-screencapturekit', running: false, pausedReason: 'Live capture active', liveAvailable: true }));
    render(<StreamCard />);
    expect(screen.getByText('Live · ScreenCaptureKit')).toBeInTheDocument();
    expect(screen.getByText('Live frames captured from the iPhone Mirroring window.')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Live capture active')).toBeInTheDocument();
  });

  it('says Off when live capture is turned off in Settings', () => {
    boot(makeStream({ liveAvailable: false }), makeSettings((x) => (x.connection.screenshot.liveCapture = false)));
    render(<StreamCard />);
    expect(screen.getByText('Off')).toBeInTheDocument();
  });
});

describe('DevicePanel screen updates', () => {
  it('reports the mode and why the live view is not active', () => {
    boot(makeStream({ liveAvailable: false, liveError: 'Screen Recording permission denied' }));
    render(<DevicePanel manual={manual} typeFieldRef={createRef<HTMLInputElement>()} />);
    expect(screen.getByText('Polling screenshots — not video.')).toBeInTheDocument();
    expect(screen.getByText('Polling screenshots')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Screen Recording permission denied')).toBeInTheDocument();
  });

  it('reports the backend’s live mode', () => {
    boot(makeStream({ mode: 'live-screencapturekit', liveAvailable: true }));
    render(<DevicePanel manual={manual} typeFieldRef={createRef<HTMLInputElement>()} />);
    expect(screen.getByText('Live · ScreenCaptureKit')).toBeInTheDocument();
    // This device isn't receiving live frames itself (no viewer connected here).
    expect(screen.getByText('Not active')).toBeInTheDocument();
  });
});
