// Settings › iPhone Connection: the live view (ScreenCaptureKit) switch and
// frame rate, saved as a patch of only the changed key.

import { LIVE_CONFLICT_ERROR, type AppSettings, type SettingsPatch } from '@iphone-ai/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLanguage } from '../../lib/i18n';
import { appStore, reduceBootstrap, resetStoreForTests } from '../../state/store';
import { jsonResponse } from '../../test/http';
import { makeBootstrap, makeSettings, makeStream } from '../../test/fixtures';
import SettingsPage from './index';

let current: AppSettings;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  resetStoreForTests();
  current = makeSettings();
  appStore.setState((s) =>
    reduceBootstrap(s, makeBootstrap({ settings: current, stream: makeStream({ liveAvailable: false, liveError: 'Capture helper not installed' }) })),
  );
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === '/api/settings' && init?.method === 'PUT') {
      const patch = JSON.parse(String(init.body)) as SettingsPatch;
      current = { ...current, connection: { ...current.connection, ...patch.connection } };
      return jsonResponse(200, current);
    }
    if (url === '/api/connection/doctor') return jsonResponse(200, { checks: [] });
    return jsonResponse(404, { error: { code: 'not_found', message: url } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
  setLanguage('en');
});

const puts = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/settings' && init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)));

describe('live view settings', () => {
  it('shows the switch, the frame rate and why live capture is unavailable', async () => {
    render(<SettingsPage section="connection" />);
    expect(screen.getByRole('switch', { name: /Live view \(ScreenCaptureKit\)/ })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Live frame rate' })).toHaveValue('15');
    expect(screen.getByText('Live capture unavailable — screenshots are polled instead')).toBeInTheDocument();
    expect(screen.getByText('Capture helper not installed')).toBeInTheDocument();
    await act(async () => Promise.resolve());
  });

  it('says so when live capture is available', async () => {
    act(() => appStore.setState({ stream: makeStream({ liveAvailable: true }) }));
    render(<SettingsPage section="connection" />);
    expect(screen.getByText('Live capture available')).toBeInTheDocument();
    expect(screen.queryByText('Capture helper not installed')).toBeNull();
    await act(async () => Promise.resolve());
  });

  it('shows the capture-conflict notice in the UI language', async () => {
    act(() => appStore.setState({ stream: makeStream({ liveAvailable: false, liveError: LIVE_CONFLICT_ERROR }) }));
    const first = render(<SettingsPage section="connection" />);
    expect(screen.getByText(LIVE_CONFLICT_ERROR)).toBeInTheDocument();
    await act(async () => Promise.resolve());
    first.unmount();

    act(() => setLanguage('ar'));
    render(<SettingsPage section="connection" />);
    expect(screen.getByText(/^العرض المباشر متوقف في هذه الجلسة/)).toBeInTheDocument();
    expect(screen.queryByText(LIVE_CONFLICT_ERROR)).toBeNull();
    await act(async () => Promise.resolve());
  });

  it('turning it off saves only the screenshot settings and disables the frame rate', async () => {
    render(<SettingsPage section="connection" />);
    await userEvent.click(screen.getByRole('switch', { name: /Live view \(ScreenCaptureKit\)/ }));
    expect(screen.getByRole('textbox', { name: 'Live frame rate' })).toBeDisabled();
    expect(screen.getByText('Live capture is off — screenshots are polled')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /^save/i }));
    await waitFor(() =>
      expect(puts()).toEqual([
        { connection: { screenshot: { ...makeSettings().connection.screenshot, liveCapture: false } } },
      ]),
    );
    await waitFor(() => expect(appStore.getState().settings?.connection.screenshot.liveCapture).toBe(false));
  });

  it('limits the live frame rate to 5–15 fps (single screenshots)', async () => {
    render(<SettingsPage section="connection" />);
    const field = screen.getByRole('textbox', { name: 'Live frame rate' });
    await userEvent.clear(field);
    await userEvent.type(field, '30');
    await userEvent.tab();
    // The field clamps to its range; a valid value is saved as a whole number.
    expect(field).toHaveValue('15');
    await userEvent.clear(field);
    await userEvent.type(field, '4');
    await userEvent.tab();
    expect(field).toHaveValue('5');
    await userEvent.click(await screen.findByRole('button', { name: /^save/i }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].connection.screenshot.liveFps).toBe(5);
  });
});
