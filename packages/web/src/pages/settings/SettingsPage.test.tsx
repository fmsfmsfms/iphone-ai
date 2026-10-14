import type { AppSettings, SettingsPatch } from '@iphone-ai/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeBootstrap, makeSettings } from '../../test/fixtures';
import { appStore, reduceBootstrap, resetStoreForTests } from '../../state/store';
import SettingsPage from './index';
import { SECTION_IDS } from './helpers';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Applies a settings patch the way the backend does (section by section). */
function applyPatch(settings: AppSettings, patch: SettingsPatch): AppSettings {
  const next = structuredClone(settings) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, values] of Object.entries(patch)) Object.assign(next[section]!, values);
  return next as unknown as AppSettings;
}

let current: AppSettings;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function routes(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (url === '/api/settings' && method === 'PUT') {
    current = applyPatch(current, JSON.parse(String(init?.body)) as SettingsPatch);
    return json(200, current);
  }
  if (url === '/api/settings') return json(200, current);
  if (url === '/api/connection/doctor')
    return json(200, {
      checks: [
        { name: 'Mirroir binary', status: 'ok', detail: 'Found /opt/homebrew/bin/mirroir' },
        { name: 'Accessibility', status: 'fail', detail: 'Not granted', fix_hint: 'Open System Settings › Privacy & Security › Accessibility' },
        // Mirroir 0.40.1's real hint while paused (iPhone Mirroring needs the iPhone locked).
        {
          name: 'Mirroring connected',
          status: 'failed',
          detail: 'paused',
          fix_hint: 'iPhone Mirroring is paused. Unlock your iPhone and click Resume in the mirroring window.',
        },
      ],
    });
  if (url === '/api/providers/claude-code/status')
    return json(200, { available: true, binaryPath: '/bin/claude', loggedIn: false, authMethod: '', detail: 'Not logged in' });
  if (url === '/api/remote')
    return json(200, {
      settings: current.remote,
      listening: false,
      url: null,
      addresses: [
        { iface: 'utun4', address: '100.101.1.2', tailscale: true },
        { iface: 'en0', address: '192.168.1.20', tailscale: false },
      ],
      error: null,
    });
  if (url === '/api/remote/sessions') return json(200, []);
  if (url === '/api/connection/stderr') return json(200, ['mirroir: ready']);
  if (url === '/api/connection/tools') return json(200, [{ name: 'tap', description: 'Tap at a point', mutating: true, inputSchema: {} }]);
  if (url === '/api/diagnostics/info')
    return json(200, {
      version: '0.1.0',
      node: 'v22.22.3',
      platform: 'darwin',
      arch: 'arm64',
      dataDir: '~/Library/Application Support/iPhone AI',
      mirroirBinary: '/opt/homebrew/bin/mirroir',
      mirroirVersion: '0.40.1',
    });
  return json(404, { error: { code: 'not_found', message: `No mock for ${method} ${url}` } });
}

beforeEach(() => {
  resetStoreForTests();
  current = makeSettings();
  appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: current })));
  fetchMock = vi.fn<typeof fetch>(async (input, init) => routes(input, init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
});

const puts = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/settings' && init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)));

describe('SettingsPage', () => {
  it.each(SECTION_IDS)('renders the %s section', async (section) => {
    render(<SettingsPage section={section} />);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
    // Let section loaders settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  it('treats #/settings/ai as AI Providers and shows the personal-use notice', async () => {
    render(<SettingsPage section="ai" />);
    expect(screen.getByRole('heading', { level: 2, name: 'AI Providers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'AI Providers' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByText('Claude (Claude Code login)').length).toBeGreaterThan(0);
  });

  it('saves General changes immediately with a patch of only that setting', async () => {
    render(<SettingsPage section="general" />);
    await userEvent.click(screen.getByRole('radio', { name: /light/i }));
    await waitFor(() => expect(puts()).toEqual([{ general: { theme: 'light' } }]));
    await waitFor(() => expect(appStore.getState().settings?.general.theme).toBe('light'));
  });

  it('sends only the changed keys when a section is saved', async () => {
    render(<SettingsPage section="privacy" />);
    expect(screen.queryByRole('button', { name: /^save/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Store screenshots' }));
    const save = await screen.findByRole('button', { name: /^save/i });
    await userEvent.click(save);
    await waitFor(() => expect(puts()).toEqual([{ privacy: { storeScreenshots: true } }]));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows stored numbers exactly (no snapping to the increment step)', async () => {
    current = makeSettings((s) => {
      s.connection.requestTimeoutMs = 64000;
      s.connection.screenshot = { ...s.connection.screenshot, activeFps: 2, idleAfterMs: 31000 };
    });
    act(() => appStore.setState((st) => reduceBootstrap(st, makeBootstrap({ settings: current }))));
    render(<SettingsPage section="connection" />);
    expect(screen.getByRole('textbox', { name: 'Request timeout' })).toHaveValue('64');
    expect(screen.getByRole('textbox', { name: 'Rate while you’re active' })).toHaveValue('2');
    expect(screen.getByRole('textbox', { name: 'Go idle after' })).toHaveValue('31');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('shows doctor results with fix hints', async () => {
    render(<SettingsPage section="connection" />);
    expect(await screen.findByText('Accessibility', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText(/Privacy & Security › Accessibility/)).toBeInTheDocument();
    expect(screen.getByText('2 checks need attention')).toBeInTheDocument();
    // Mirroir's "Unlock your iPhone" hint for a paused session is replaced with the correct guidance.
    expect(screen.getByText(/Lock your iPhone and keep it nearby, then click Resume/)).toBeInTheDocument();
    expect(screen.queryByText(/Unlock your iPhone/)).toBeNull();
  });

  it('asks for confirmation before allowing remote control', async () => {
    render(<SettingsPage section="remote" />);
    await userEvent.click(screen.getByRole('switch', { name: 'Allow remote control' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Allow remote control?')).toBeInTheDocument();
    expect(puts()).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(puts()).toEqual([{ remote: { allowRemoteControl: true } }]));
  });

  it('keeps remote-access switches locked until a passcode exists', async () => {
    render(<SettingsPage section="remote" />);
    expect(screen.getByRole('switch', { name: 'Allow remote access' })).toBeDisabled();
    expect(screen.getByText('Set a passcode first.')).toBeInTheDocument();
  });

  it('is read-only for view-only sessions', async () => {
    act(() => {
      appStore.setState({ session: { id: 's', kind: 'remote', canControl: false, remote: true } });
    });
    render(<SettingsPage section="automation" />);
    expect(screen.getByText('This session is view-only, so settings can’t be changed here.')).toBeInTheDocument();
  });

  it('lets remote sessions change only General settings', async () => {
    act(() => {
      appStore.setState({ session: { id: 's', kind: 'remote', canControl: true, remote: true } });
    });
    const { unmount } = render(<SettingsPage section="permissions" />);
    expect(screen.getByText(/can only be changed on the Mac/)).toBeInTheDocument();
    unmount();
    render(<SettingsPage section="general" />);
    expect(screen.queryByText(/can only be changed on the Mac/)).not.toBeInTheDocument();
  });
});
