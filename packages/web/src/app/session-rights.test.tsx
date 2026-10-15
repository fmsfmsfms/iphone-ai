// Controls follow what the backend lets each session do:
// - every session may pause/cancel tasks and pause/stop runs (they only reduce
//   AI activity); resume and retry need control;
// - remote devices can't switch provider, raise the control mode, turn manual
//   control on or open System Settings (the backend reserves those for the Mac).

import type { Workflow } from '@iphone-ai/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../pages/automations/messages';
import '../pages/dashboard/messages';
import '../pages/live/messages';
import { TaskProgress } from '../components/chat';
import { PermissionBanner } from '../components/PermissionBanner';
import type { SessionInfo } from '../lib/api';
import { RunView } from '../pages/automations/RunView';
import { OnboardingChecklist, useOnboardingItems } from '../pages/dashboard/Onboarding';
import { useManualControl } from '../pages/live/useManualControl';
import { appStore, reduceBootstrap, resetStoreForTests } from '../state/store';
import { makeBootstrap, makeRun, makeSettings, makeStatus, makeTask } from '../test/fixtures';
import { calledRoutes, jsonResponse, routeFetch } from '../test/http';
import { ControlModeSelector } from './ControlModeSelector';
import { ProviderSwitcher } from './ProviderSwitcher';

const LOCAL: SessionInfo = { id: 'sess_l', kind: 'desktop', canControl: true, remote: false };
const REMOTE_CONTROL: SessionInfo = { id: 'sess_r', kind: 'remote', canControl: true, remote: true };
const REMOTE_VIEW_ONLY: SessionInfo = { id: 'sess_v', kind: 'remote', canControl: false, remote: true };

function bootAs(session: SessionInfo, extra: Parameters<typeof makeBootstrap>[0] = {}) {
  act(() => appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ session, ...extra }))));
}

const workflow: Workflow = {
  id: 'wf_1',
  name: 'Morning check',
  description: '',
  steps: [{ id: 'a', type: 'launch_app', app: 'Settings' }],
  createdAt: 1,
  updatedAt: 1,
  lastRunAt: 1,
  lastRunStatus: null,
  lastSuccessAt: null,
  source: 'manual',
};

beforeEach(() => resetStoreForTests());

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
});

describe('view-only sessions can still reduce what the AI does', () => {
  it('pauses and cancels a running task', async () => {
    bootAs(REMOTE_VIEW_ONLY);
    const fetchMock = routeFetch({ 'POST /api/tasks/task_1/pause': () => jsonResponse(200, makeTask({ status: 'paused' })) });
    render(<TaskProgress task={makeTask({ status: 'running' })} />);
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calledRoutes(fetchMock)).toEqual(['POST /api/tasks/task_1/pause']));
  });

  it('can cancel but not resume a paused task', () => {
    bootAs(REMOTE_VIEW_ONLY);
    render(<TaskProgress task={makeTask({ status: 'paused' })} />);
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(screen.getByText('This session is view-only.')).toBeInTheDocument();
  });

  it('pauses and stops a live workflow run, but never resumes or retries', () => {
    bootAs(REMOTE_VIEW_ONLY);
    const { rerender } = render(<RunView run={makeRun({ status: 'running' })} workflow={workflow} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeInTheDocument();

    rerender(<RunView run={makeRun({ status: 'paused' })} workflow={workflow} />);
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();

    rerender(<RunView run={makeRun({ status: 'failed', endedAt: 5 })} workflow={workflow} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('control sessions still get Resume', () => {
    bootAs(LOCAL);
    render(<TaskProgress task={makeTask({ status: 'paused' })} />);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });
});

describe('actions reserved for the Mac', () => {
  it('provider switching is disabled for remote devices, with the reason', async () => {
    bootAs(REMOTE_CONTROL);
    render(<ProviderSwitcher />);
    await userEvent.click(screen.getByRole('button', { name: /AI provider:/ }));
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item).toBeDisabled();
    expect(screen.getByText('The AI provider can only be changed on the Mac.')).toBeInTheDocument();
  });

  it('provider switching stays available on the Mac', async () => {
    bootAs(LOCAL);
    render(<ProviderSwitcher />);
    await userEvent.click(screen.getByRole('button', { name: /AI provider:/ }));
    const items = await screen.findAllByRole('menuitemradio');
    for (const item of items) expect(item).not.toBeDisabled();
  });

  it('a remote device may only switch to Observe Only', async () => {
    bootAs(REMOTE_CONTROL, { settings: makeSettings((s) => (s.permissions.controlMode = 'assisted')) });
    render(<ControlModeSelector />);
    await userEvent.click(screen.getByRole('button', { name: /Control mode:/ }));
    expect(await screen.findByRole('menuitemradio', { name: /Observe Only/ })).not.toBeDisabled();
    expect(screen.getByRole('menuitemradio', { name: /AI Mode/ })).toBeDisabled();
    expect(screen.getByText('Assisted and AI Mode can only be turned on from the Mac.')).toBeInTheDocument();
  });

  it('a remote device never gets the escalation dialog', async () => {
    bootAs(REMOTE_CONTROL);
    const fetchMock = routeFetch({});
    render(<ControlModeSelector variant="inline" />);
    expect(screen.getByRole('menuitemradio', { name: /AI Mode/ })).toBeDisabled();
    expect(screen.getByRole('menuitemradio', { name: /Assisted/ })).toBeDisabled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function ManualHarness() {
    const manual = useManualControl();
    return (
      <>
        <span>{manual.cannotTurnOn ? 'locked' : 'unlocked'}</span>
        <button type="button" onClick={() => manual.request(!manual.enabled)}>
          toggle
        </button>
        {manual.dialog}
      </>
    );
  }

  it('manual control can’t be turned on from a remote device, but can be turned off', async () => {
    bootAs(REMOTE_CONTROL);
    const { unmount } = render(<ManualHarness />);
    expect(screen.getByText('locked')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.queryByText('Turn on manual control?')).not.toBeInTheDocument();
    unmount();

    bootAs(REMOTE_CONTROL, { settings: makeSettings((s) => (s.permissions.manualControlEnabled = true)) });
    const fetchMock = routeFetch({ 'PUT /api/control/manual': () => jsonResponse(200, makeSettings()) });
    render(<ManualHarness />);
    expect(screen.getByText('unlocked')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await waitFor(() => expect(calledRoutes(fetchMock)).toEqual(['PUT /api/control/manual']));
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(JSON.stringify({ enabled: false }));
  });

  it('manual control still asks for confirmation on the Mac', async () => {
    bootAs(LOCAL);
    render(<ManualHarness />);
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(await screen.findByText('Turn on manual control?')).toBeInTheDocument();
  });

  it('permission help on a remote device says to use the Mac instead of opening System Settings', () => {
    bootAs(REMOTE_CONTROL);
    render(<PermissionBanner panes={['screen-recording']} />);
    expect(screen.queryByRole('button', { name: 'Open Screen Recording settings' })).not.toBeInTheDocument();
    expect(screen.getByText('Open System Settings on the Mac to grant this.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('permission help on the Mac keeps the System Settings button', () => {
    bootAs(LOCAL);
    render(<PermissionBanner panes={['screen-recording']} />);
    expect(screen.getByRole('button', { name: 'Open Screen Recording settings' })).toBeInTheDocument();
  });

  function Checklist() {
    return <OnboardingChecklist items={useOnboardingItems().items} />;
  }

  it('the setup checklist does not offer System Settings to remote devices', () => {
    routeFetch({});
    const status = makeStatus({ permissions: { screenRecording: 'denied', accessibility: 'denied', source: 'doctor', checkedAt: 1 } });
    bootAs(REMOTE_CONTROL, { status });
    const { unmount } = render(<Checklist />);
    expect(screen.queryByRole('button', { name: 'Open System Settings' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Open System Settings on the Mac to grant this.').length).toBe(2);
    unmount();

    bootAs(LOCAL, { status });
    render(<Checklist />);
    expect(screen.getAllByRole('button', { name: 'Open System Settings' })).toHaveLength(2);
  });
});
