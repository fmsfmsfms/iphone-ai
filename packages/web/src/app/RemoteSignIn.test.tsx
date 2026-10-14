// The remote listener must offer a passcode sign-in (it used to show only
// "Session expired — reopen from the iPhone AI app", a dead end).

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { setLanguage, translate } from '../lib/i18n';
import { STORAGE_KEYS } from '../lib/storage';
import { realtime } from '../lib/ws';
import { appStore, bootstrap, resetStoreForTests } from '../state/store';
import { makeBootstrap } from '../test/fixtures';
import { calledRoutes, errorResponse, jsonResponse, routeFetch } from '../test/http';
import { App } from './App';
import { guessDeviceName, RemoteSignIn } from './FullScreenStates';

const REMOTE_SESSION = { id: 'sess_r', kind: 'remote', canControl: false, remote: true } as const;

beforeEach(() => {
  resetStoreForTests();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
  setLanguage('en');
});

function showSignIn() {
  act(() => appStore.setState({ boot: 'unauthorized', listenerKind: 'remote' }));
  render(<RemoteSignIn />);
}

describe('App without a session', () => {
  it('shows the passcode sign-in when the remote listener answers 401', async () => {
    routeFetch({
      '/api/bootstrap': () => errorResponse(401, 'unauthenticated', 'Sign in to iPhone AI first.'),
      '/api/health': () => jsonResponse(200, { ok: true, version: '1', listener: 'remote' }),
    });
    await act(async () => {
      await bootstrap();
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in to iPhone AI' })).toBeInTheDocument();
    expect(screen.getByLabelText('Passcode')).toHaveAttribute('type', 'password');
    expect(screen.queryByText(/reopen from the iPhone AI app/)).not.toBeInTheDocument();
  });

  it('keeps "Session expired" on the local listener', async () => {
    routeFetch({
      '/api/bootstrap': () => errorResponse(401, 'unauthenticated', 'Sign in to iPhone AI first.'),
      '/api/health': () => jsonResponse(200, { ok: true, version: '1', listener: 'local' }),
    });
    await act(async () => {
      await bootstrap();
    });
    render(<App />);
    await waitFor(() => expect(appStore.getState().listenerKind).toBe('local'));
    expect(screen.getByRole('heading', { name: /Session expired/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Passcode')).not.toBeInTheDocument();
  });

  it('sends a remote user whose session ended back to the sign-in, with a note', () => {
    // The session was revoked or expired while the app was open.
    act(() => appStore.setState({ session: REMOTE_SESSION, listenerKind: 'remote', boot: 'unauthorized' }));
    render(<App />);
    expect(screen.getByText('Your remote session ended. Sign in again to continue.')).toBeInTheDocument();
    expect(screen.getByLabelText('Passcode')).toBeInTheDocument();
  });
});

describe('RemoteSignIn', () => {
  it('explains a wrong passcode, clears the field and keeps focus there', async () => {
    routeFetch({ 'POST /api/auth/remote-login': () => errorResponse(401, 'invalid_passcode', 'The passcode is not correct.') });
    showSignIn();
    const field = screen.getByLabelText('Passcode');
    await userEvent.type(field, 'wrong-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That passcode isn’t correct.')).toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(appStore.getState().boot).toBe('unauthorized');
  });

  it('counts down a rate limit and blocks signing in until it ends', async () => {
    routeFetch({
      'POST /api/auth/remote-login': () =>
        errorResponse(429, 'rate_limited', 'Too many failed attempts. Try again in 2 minute(s).', { 'retry-after': '90' }),
    });
    showSignIn();
    await userEvent.type(screen.getByLabelText('Passcode'), 'guess');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Too many sign-in attempts. You can try again in 1:30.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('says when no passcode is set on the Mac', async () => {
    routeFetch({ 'POST /api/auth/remote-login': () => errorResponse(403, 'remote_not_configured', 'Remote access has no passcode set on the Mac.') });
    showSignIn();
    await userEvent.type(screen.getByLabelText('Passcode'), 'anything');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/No passcode is set on the Mac/)).toBeInTheDocument();
  });

  it('signs in, loads the app, then reconnects the socket', async () => {
    const order: string[] = [];
    const fetchMock = routeFetch({
      'POST /api/auth/remote-login': () => {
        order.push('login');
        return jsonResponse(200, { ok: true });
      },
      '/api/bootstrap': () => {
        order.push('bootstrap');
        return jsonResponse(200, makeBootstrap({ session: REMOTE_SESSION }));
      },
    });
    const reconnect = vi.spyOn(realtime, 'reconnectNow').mockImplementation(() => {
      // The socket may only connect once boot has left 'unauthorized'.
      order.push(`reconnect:${appStore.getState().boot}`);
    });
    showSignIn();
    await userEvent.type(screen.getByLabelText('Passcode'), 'correct horse');
    const name = screen.getByLabelText('This device’s name (optional)');
    await userEvent.clear(name);
    await userEvent.type(name, 'Kitchen iPad');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['login', 'bootstrap', 'reconnect:ready']);
    const login = fetchMock.mock.calls.find(([url]) => url === '/api/auth/remote-login')!;
    expect(login[1]?.body).toBe(JSON.stringify({ passcode: 'correct horse', deviceName: 'Kitchen iPad' }));
    expect(calledRoutes(fetchMock)).toEqual(['POST /api/auth/remote-login', 'GET /api/bootstrap']);
    expect(appStore.getState().session).toEqual(REMOTE_SESSION);
    // The device name is remembered for next time; the passcode is not stored anywhere.
    expect(window.localStorage.getItem(STORAGE_KEYS.remoteDeviceName)).toBe(JSON.stringify('Kitchen iPad'));
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('correct horse');
  });

  it('reports that the Mac can’t be reached', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')));
    showSignIn();
    await userEvent.type(screen.getByLabelText('Passcode'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Can’t reach the Mac/)).toBeInTheDocument();
  });
});

describe('guessDeviceName', () => {
  const t = (key: string, vars?: Record<string, string | number | null | undefined>) => translate('en', key, vars);
  it('names common browsers and devices', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', t)).toBe(
      'Safari on iPhone',
    );
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', t)).toBe('Chrome on Android');
    expect(guessDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0', t)).toBe('Edge on Windows');
    expect(guessDeviceName('', t)).toBe('');
  });
});

it('ApiError carries Retry-After seconds', () => {
  expect(new ApiError(429, 'rate_limited', 'x', 30).retryAfterSec).toBe(30);
  expect(new ApiError(500, 'x', 'y').retryAfterSec).toBeNull();
});
