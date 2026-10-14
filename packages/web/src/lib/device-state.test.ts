import { describe, expect, it } from 'vitest';

import { viewerBlock } from '../components/phone/ViewerOverlay';
import { makeFrame, makeSettings, makeStatus, makeStream, makeTask } from '../test/fixtures';
import {
  composerDisabledReason,
  manualInputAvailability,
  missingPermissions,
  providerReadiness,
  touchAvailability,
  type ManualInputContext,
} from './device-state';

const session = { id: 's', kind: 'desktop' as const, canControl: true, remote: false };

function ctx(overrides: Partial<ManualInputContext> = {}): ManualInputContext {
  return {
    status: makeStatus(),
    settings: makeSettings((s) => (s.permissions.manualControlEnabled = true)),
    session,
    activeTask: null,
    activeRun: null,
    ...overrides,
  };
}

describe('manualInputAvailability', () => {
  it('allows input when everything is ready', () => {
    expect(manualInputAvailability(ctx())).toEqual({ allowed: true, reasonKey: null });
  });

  it('explains each blocking condition', () => {
    expect(manualInputAvailability(ctx({ session: { ...session, canControl: false } })).reasonKey).toBe('input.reason.viewOnly');
    expect(manualInputAvailability(ctx({ status: makeStatus({ stopLatched: true }) })).reasonKey).toBe('input.reason.stopLatched');
    expect(manualInputAvailability(ctx({ settings: makeSettings() })).reasonKey).toBe('input.reason.manualOff');
    const crashed = makeStatus();
    crashed.server.state = 'crashed';
    expect(manualInputAvailability(ctx({ status: crashed })).reasonKey).toBe('input.reason.mcpNotReady');
    const paused = makeStatus();
    paused.mirroring.state = 'paused';
    expect(manualInputAvailability(ctx({ status: paused })).reasonKey).toBe('input.reason.paused');
    expect(manualInputAvailability(ctx({ status: makeStatus({ controlOwner: 'ai' }), activeTask: makeTask() })).reasonKey).toBe('input.reason.aiOwns');
  });

  it('allows manual input while the owning task is paused', () => {
    const result = manualInputAvailability(ctx({ status: makeStatus({ controlOwner: 'ai' }), activeTask: makeTask({ status: 'paused' }) }));
    expect(result.allowed).toBe(true);
  });
});

describe('touchAvailability', () => {
  it('needs frame geometry that matches the live window', () => {
    expect(touchAvailability(ctx(), makeFrame(1), { width: 820, height: 1780 }).allowed).toBe(true);
    expect(touchAvailability(ctx(), makeFrame(1, { pxPerPt: null }), null).reasonKey).toBe('input.reason.geometryUnknown');
    const rotated = makeStatus();
    rotated.mirroring.geometry = { widthPt: 890, heightPt: 410, orientation: 'landscape', geometryId: '890x410', observedAt: 2 };
    expect(touchAvailability(ctx({ status: rotated }), makeFrame(1), null).reasonKey).toBe('input.reason.geometryOutdated');
    expect(touchAvailability(ctx(), makeFrame(1), { width: 1780, height: 820 }).reasonKey).toBe('input.reason.geometryOutdated');
  });
});

describe('providerReadiness', () => {
  it('requires an API key for cloud API providers', () => {
    expect(providerReadiness(makeSettings()).reasonKey).toBe('provider.reason.noKey');
    const withKey = makeSettings((s) => (s.ai.providers[0]!.hasApiKey = true));
    expect(providerReadiness(withKey).configured).toBe(true);
  });

  it('requires a model for local servers', () => {
    const local = makeSettings((s) => (s.ai.activeProviderId = 'lmstudio'));
    expect(providerReadiness(local).reasonKey).toBe('provider.reason.noModel');
    const withModel = makeSettings((s) => {
      s.ai.activeProviderId = 'lmstudio';
      s.ai.providers.find((p) => p.id === 'lmstudio')!.model = 'qwen3-vl';
    });
    expect(providerReadiness(withModel).configured).toBe(true);
  });
});

describe('composerDisabledReason', () => {
  const ready = makeSettings((s) => (s.ai.providers[0]!.hasApiKey = true));
  it('returns null when a task can start', () => {
    expect(composerDisabledReason({ settings: ready, session, stopLatched: false, activeTask: null, connected: true })).toBeNull();
  });
  it('explains why not', () => {
    expect(composerDisabledReason({ settings: ready, session, stopLatched: false, activeTask: null, connected: false })).toBe('composer.reason.offline');
    expect(composerDisabledReason({ settings: ready, session, stopLatched: true, activeTask: null, connected: true })).toBe('composer.reason.stopLatched');
    expect(composerDisabledReason({ settings: makeSettings(), session, stopLatched: false, activeTask: null, connected: true })).toBe('composer.reason.noProvider');
    expect(composerDisabledReason({ settings: ready, session, stopLatched: false, activeTask: makeTask(), connected: true })).toBe('composer.reason.taskRunning');
  });
});

describe('missingPermissions', () => {
  it('lists panes that are not granted', () => {
    expect(missingPermissions(makeStatus())).toEqual([]);
    const s = makeStatus();
    s.permissions.screenRecording = 'unknown';
    expect(missingPermissions(s)).toEqual(['screen-recording']);
  });
});

describe('viewerBlock', () => {
  it('prioritises MCP, mirroring and permission problems', () => {
    expect(viewerBlock(null, null, false)).toEqual({ kind: 'loading' });
    const missing = makeStatus();
    missing.server.state = 'binary_missing';
    expect(viewerBlock(missing, null, true)?.kind).toBe('mcp');
    const notRunning = makeStatus();
    notRunning.mirroring.state = 'not_running';
    expect(viewerBlock(notRunning, null, true)?.kind).toBe('not_running');
    const paused = makeStatus();
    paused.mirroring.state = 'paused';
    expect(viewerBlock(paused, null, true)?.kind).toBe('paused');
    const noSr = makeStatus();
    noSr.permissions.screenRecording = 'denied';
    expect(viewerBlock(noSr, null, true)?.kind).toBe('screen_recording');
  });

  it('waits for the first frame, then shows frames', () => {
    expect(viewerBlock(makeStatus(), makeStream({ pausedReason: 'No visible viewer' }), false)).toEqual({ kind: 'waiting', pausedReason: 'No visible viewer' });
    expect(viewerBlock(makeStatus(), makeStream(), true)).toBeNull();
  });
});
