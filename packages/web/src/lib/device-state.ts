// Derived, display-oriented state: status chip tones, why input is disabled,
// whether an AI provider is usable. Pure functions returning i18n keys.

import type {
  AgentTask,
  AppSettings,
  ControlOwner,
  DeviceStatus,
  FrameMeta,
  McpServerState,
  MirroringState,
  ProviderConfig,
  WorkflowRun,
} from '@iphone-ai/shared';

import type { SessionInfo, SettingsPane } from './api-types';

export type Tone = 'success' | 'warning' | 'danger' | 'default' | 'accent' | 'ai';

export interface ChipInfo {
  tone: Tone;
  labelKey: string;
  hintKey: string;
}

export function mcpChip(state: McpServerState | undefined): ChipInfo {
  switch (state) {
    case 'ready':
      return { tone: 'success', labelKey: 'status.mcp.ready', hintKey: 'status.mcp.readyHint' };
    case 'starting':
    case 'restarting':
      return { tone: 'accent', labelKey: 'status.mcp.starting', hintKey: 'status.mcp.startingHint' };
    case 'crashed':
      return { tone: 'danger', labelKey: 'status.mcp.crashed', hintKey: 'status.mcp.crashedHint' };
    case 'binary_missing':
      return { tone: 'danger', labelKey: 'status.mcp.binaryMissing', hintKey: 'status.mcp.binaryMissingHint' };
    case 'stopped':
      return { tone: 'warning', labelKey: 'status.mcp.stopped', hintKey: 'status.mcp.stoppedHint' };
    default:
      return { tone: 'default', labelKey: 'status.mcp.unknown', hintKey: 'status.mcp.unknownHint' };
  }
}

export function mirroringChip(state: MirroringState | undefined): ChipInfo {
  switch (state) {
    case 'connected':
      return { tone: 'success', labelKey: 'status.mirroring.connected', hintKey: 'status.mirroring.connectedHint' };
    case 'paused':
      return { tone: 'warning', labelKey: 'status.mirroring.paused', hintKey: 'status.mirroring.pausedHint' };
    case 'not_running':
      return { tone: 'danger', labelKey: 'status.mirroring.notRunning', hintKey: 'status.mirroring.notRunningHint' };
    case 'no_window':
      return { tone: 'warning', labelKey: 'status.mirroring.noWindow', hintKey: 'status.mirroring.noWindowHint' };
    case 'error':
      return { tone: 'danger', labelKey: 'status.mirroring.error', hintKey: 'status.mirroring.errorHint' };
    default:
      return { tone: 'default', labelKey: 'status.mirroring.unknown', hintKey: 'status.mirroring.unknownHint' };
  }
}

export function missingPermissions(status: DeviceStatus | null): SettingsPane[] {
  if (!status) return [];
  const missing: SettingsPane[] = [];
  if (status.permissions.screenRecording !== 'granted') missing.push('screen-recording');
  if (status.permissions.accessibility !== 'granted') missing.push('accessibility');
  return missing;
}

export interface Availability {
  allowed: boolean;
  /** i18n key explaining why the control is disabled (null when allowed). */
  reasonKey: string | null;
}

const OK: Availability = { allowed: true, reasonKey: null };
const no = (reasonKey: string): Availability => ({ allowed: false, reasonKey });

/** Whether a lease owner leaves room for manual input (the server allows it while the task/run is paused). */
export function ownerAllowsManual(owner: ControlOwner, activeTask: AgentTask | null, activeRun: WorkflowRun | null): boolean {
  if (owner === 'none' || owner === 'manual') return true;
  if (owner === 'ai') return activeTask?.status === 'paused';
  if (owner === 'workflow') return activeRun?.status === 'paused';
  return false;
}

export interface ManualInputContext {
  status: DeviceStatus | null;
  settings: AppSettings | null;
  session: SessionInfo | null;
  activeTask: AgentTask | null;
  activeRun: WorkflowRun | null;
}

/** Why manual buttons (home, type text, …) are or are not usable right now. */
export function manualInputAvailability(ctx: ManualInputContext): Availability {
  const { status, settings, session } = ctx;
  if (!status || !settings) return no('input.reason.loading');
  if (session && !session.canControl) return no('input.reason.viewOnly');
  if (status.stopLatched) return no('input.reason.stopLatched');
  if (!settings.permissions.manualControlEnabled) return no('input.reason.manualOff');
  if (status.server.state !== 'ready') return no('input.reason.mcpNotReady');
  if (status.mirroring.state === 'paused') return no('input.reason.paused');
  if (status.mirroring.state !== 'connected') return no('input.reason.notConnected');
  if (!ownerAllowsManual(status.controlOwner, ctx.activeTask, ctx.activeRun)) {
    return no(status.controlOwner === 'workflow' ? 'input.reason.workflowOwns' : 'input.reason.aiOwns');
  }
  return OK;
}

/** Touches additionally need a frame whose geometry matches the live window. */
export function touchAvailability(ctx: ManualInputContext, frame: FrameMeta | null, natural: { width: number; height: number } | null): Availability {
  const base = manualInputAvailability(ctx);
  if (!base.allowed) return base;
  if (!frame || !frame.geometry || !frame.pxPerPt) return no('input.reason.geometryUnknown');
  const live = ctx.status?.mirroring.geometry;
  if (live && live.geometryId !== frame.geometry.geometryId) return no('input.reason.geometryOutdated');
  if (natural && (natural.width !== frame.widthPx || natural.height !== frame.heightPx)) return no('input.reason.geometryOutdated');
  return OK;
}

export interface ProviderReadiness {
  provider: ProviderConfig | null;
  configured: boolean;
  reasonKey: string | null;
}

/** Whether the active provider can be used (key stored, or a local server with a model). */
export function providerReadiness(settings: AppSettings | null, providerId?: string | null): ProviderReadiness {
  if (!settings) return { provider: null, configured: false, reasonKey: 'provider.reason.loading' };
  const id = providerId ?? settings.ai.activeProviderId;
  const provider = settings.ai.providers.find((p) => p.id === id) ?? null;
  if (!provider) return { provider: null, configured: false, reasonKey: 'provider.reason.none' };
  if (!provider.enabled) return { provider, configured: false, reasonKey: 'provider.reason.disabled' };
  switch (provider.kind) {
    case 'anthropic':
    case 'openai':
      return provider.hasApiKey
        ? { provider, configured: true, reasonKey: null }
        : { provider, configured: false, reasonKey: 'provider.reason.noKey' };
    case 'openai-compatible':
      if (!provider.baseUrl) return { provider, configured: false, reasonKey: 'provider.reason.noUrl' };
      if (!provider.model) return { provider, configured: false, reasonKey: 'provider.reason.noModel' };
      return { provider, configured: true, reasonKey: null };
    case 'claude-agent-sdk':
      // Login state is checked by the backend when a task starts (GET /api/providers/claude-code/status).
      return { provider, configured: true, reasonKey: null };
    default:
      return { provider, configured: false, reasonKey: 'provider.reason.none' };
  }
}

/** Whether the provider sends data off this Mac and the user hasn't acknowledged that yet. */
export function needsCloudDisclosure(settings: AppSettings | null, provider: ProviderConfig | null): boolean {
  return Boolean(settings && provider?.cloud && !settings.privacy.cloudDisclosureAcknowledged);
}

export interface ComposerContext {
  settings: AppSettings | null;
  session: SessionInfo | null;
  stopLatched: boolean;
  activeTask: AgentTask | null;
  connected: boolean;
}

/** i18n key explaining why a new AI instruction cannot be sent (null when it can). */
export function composerDisabledReason(ctx: ComposerContext): string | null {
  if (!ctx.connected) return 'composer.reason.offline';
  if (ctx.session && !ctx.session.canControl) return 'composer.reason.viewOnly';
  if (ctx.stopLatched) return 'composer.reason.stopLatched';
  const readiness = providerReadiness(ctx.settings);
  if (!readiness.configured) return 'composer.reason.noProvider';
  if (ctx.activeTask) return 'composer.reason.taskRunning';
  return null;
}

/** Higher number = more autonomy. Escalating requires confirmation. */
export const MODE_LEVEL = { observe: 0, assisted: 1, supervised: 2 } as const;
