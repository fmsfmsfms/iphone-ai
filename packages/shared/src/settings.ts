// Application settings. Secrets (API keys, remote passcode) are never part of
// these objects — they live in the macOS Keychain and are referenced by flags.

import type { ProviderConfig } from './agent.js';
import type { ControlMode } from './control.js';

export type ThemePreference = 'dark' | 'light' | 'system';
export type Language = 'en' | 'ar';

export interface GeneralSettings {
  theme: ThemePreference;
  language: Language;
  notifications: boolean;
  /** Launch Apple's iPhone Mirroring app when iPhone AI starts. */
  openMirroringOnLaunch: boolean;
  /** Bring iPhone AI back to the front after a manual action activates iPhone Mirroring. */
  refocusAfterManualAction: boolean;
  onboardingCompleted: boolean;
}

export interface ConnectionSettings {
  mirroirBinaryPath: string;
  target: string;
  /** Per-call MCP request timeout. */
  requestTimeoutMs: number;
  screenshot: {
    activeFps: number;
    idleFps: number;
    /** Drop to idle rate after this long without user interaction or AI activity. */
    idleAfterMs: number;
    /** Stop polling entirely when no viewer is visible. */
    pauseWhenHidden: boolean;
  };
}

export interface AiSettings {
  activeProviderId: string;
  /** Optional separate provider used for screen interpretation when the main model is text-only. */
  visionProviderId: string | null;
  maxActionsPerTask: number;
  maxTaskDurationSec: number;
  /** Delay after an action before the verifying observation, in ms. */
  settleDelayMs: number;
  providers: ProviderConfig[];
}

export interface SensitiveRule {
  id: string;
  label: string;
  /** Case-insensitive substrings matched against on-screen text, target labels and typed text. */
  keywords: string[];
  /** What happens when a rule matches an AI or workflow action. */
  effect: 'require_approval' | 'deny';
  enabled: boolean;
}

export interface PermissionSettings {
  controlMode: ControlMode;
  /** Allows clicking/dragging on the live viewer to control the phone. */
  manualControlEnabled: boolean;
  /** Mirroir tools the AI may use (subset of tools the permission file exposes). */
  aiAllowedTools: string[];
  /** Apps the AI and workflows may never open or interact with. Also written to Mirroir's blockedApps. */
  blockedApps: string[];
  sensitiveRules: SensitiveRule[];
  /** Typing is refused for AI/workflows when the screen looks like a password/OTP/passcode prompt. */
  blockTypingOnAuthScreens: boolean;
  approvalTimeoutSec: number;
  /** Audit every manual action (always on for AI/workflow actions). */
  auditManualActions: boolean;
}

export interface AutomationSettings {
  maxStepsPerRun: number;
  maxRunDurationSec: number;
  defaultWaitTimeoutMs: number;
  /** Unattended / scheduled runs stay disabled until interruption behaviour has been validated. */
  unattendedRunsEnabled: false;
}

export interface PrivacySettings {
  /** Persist screenshots attached to AI steps and workflow runs (off by default). */
  storeScreenshots: boolean;
  screenshotRetentionDays: number;
  /** Store typed text in the activity history (off by default: only the length is recorded). */
  logTypedText: boolean;
  historyRetentionDays: number;
  /** User acknowledged that screenshots are sent to cloud AI providers when one is selected. */
  cloudDisclosureAcknowledged: boolean;
}

export interface AdvancedSettings {
  debugLogging: boolean;
  /** Write a detailed MCP transcript (redacted) to the debug log. */
  mcpTrace: boolean;
}

export interface RemoteSettings {
  enabled: boolean;
  /** Address to bind when remote access is on (e.g. a Tailscale 100.x address). Localhost is always served. */
  bindAddress: string;
  port: number;
  passcodeSet: boolean;
  /** Remote sessions may run AI/manual control; otherwise remote viewers are read-only. */
  allowRemoteControl: boolean;
  sessionTtlHours: number;
}

export interface AppSettings {
  version: 1;
  general: GeneralSettings;
  connection: ConnectionSettings;
  ai: AiSettings;
  permissions: PermissionSettings;
  automation: AutomationSettings;
  privacy: PrivacySettings;
  advanced: AdvancedSettings;
  remote: RemoteSettings;
}

/** Deep-partial patch accepted by PUT /api/settings. */
export type SettingsPatch = {
  [K in keyof Omit<AppSettings, 'version'>]?: Partial<AppSettings[K]>;
};
