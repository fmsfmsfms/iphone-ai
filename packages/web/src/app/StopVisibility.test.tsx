// STOP must stay reachable: inside the full-window enlarged phone view (which
// covers the top bar) and on phone-width browsers (where the top bar used to
// push it off-screen).

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhoneViewer } from '../components/phone/PhoneViewer';
import { appStore, reduceBootstrap, resetStoreForTests, setConnection } from '../state/store';
import { makeBootstrap, makeSettings, makeStatus } from '../test/fixtures';
import { StopControl } from './StopControl';
import { TopBar } from './TopBar';

beforeEach(() => {
  resetStoreForTests();
  act(() => appStore.setState((s) => reduceBootstrap(s, makeBootstrap())));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
});

describe('enlarged phone viewer', () => {
  it('has its own STOP button, since it covers the top bar', async () => {
    render(<PhoneViewer interactive toolbar />);
    expect(screen.queryAllByRole('button', { name: 'STOP AI CONTROL' })).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Enlarge' }));
    const dialog = await screen.findByRole('dialog', { name: 'iPhone screen' });
    expect(within(dialog).getByRole('button', { name: 'STOP AI CONTROL' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows the latched state there too', async () => {
    act(() => appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ status: makeStatus({ stopLatched: true, stopReason: 'Test' }) }))));
    render(<PhoneViewer interactive toolbar />);
    await userEvent.click(screen.getByRole('button', { name: 'Enlarge' }));
    const dialog = await screen.findByRole('dialog', { name: 'iPhone screen' });
    expect(within(dialog).getByRole('button', { name: 'Stopped — Re-arm control' })).toBeInTheDocument();
  });
});

describe('top bar at phone widths', () => {
  it('keeps STOP in a group that never shrinks; the status side absorbs the overflow', () => {
    act(() => {
      appStore.setState((s) =>
        reduceBootstrap(
          s,
          makeBootstrap({
            settings: makeSettings((x) => (x.permissions.manualControlEnabled = true)),
            status: makeStatus({ permissions: { screenRecording: 'denied', accessibility: 'denied', source: 'doctor', checkedAt: 1 } }),
          }),
        ),
      );
      setConnection({ socket: 'reconnecting' });
    });
    render(<TopBar />);
    const stop = screen.getByRole('button', { name: 'STOP AI CONTROL' });
    const controls = stop.closest('header > div')!;
    expect(controls.className).toContain('shrink-0');
    expect(controls.className).not.toContain('min-w-0');
    // Warnings and the Reconnecting chip live in the clipped status group, not next to STOP.
    const status = screen.getByText('Reconnecting…').closest('header > div')!;
    expect(status).not.toBe(controls);
    expect(status.className).toEqual(expect.stringContaining('overflow-hidden'));
    expect(status.className).toEqual(expect.stringContaining('flex-1'));
    expect(within(status as HTMLElement).getByRole('button', { name: '2 permissions missing' })).toBeInTheDocument();
  });

  it('drops the STOP label below the sm breakpoint but keeps the accessible name', () => {
    render(<StopControl />);
    const stop = screen.getByRole('button', { name: 'STOP AI CONTROL' });
    const label = within(stop).getByText('STOP AI CONTROL');
    expect(label.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'sm:inline']));
    expect(stop.className).toContain('px-3');
    expect(stop.className).toContain('sm:px-4');
  });

  it('does the same for the latched "Re-arm" button', () => {
    act(() => appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ status: makeStatus({ stopLatched: true, stopReason: 'Test' }) }))));
    render(<StopControl />);
    const button = screen.getByRole('button', { name: 'Stopped — Re-arm control' });
    expect(within(button).getByText('Stopped — Re-arm control').className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'sm:inline']));
    expect(button.className).toContain('px-3');
  });
});
