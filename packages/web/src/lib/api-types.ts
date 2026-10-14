// Response shapes from docs/API.md that are not (yet) part of @iphone-ai/shared.
// They mirror packages/server/src/core/services.ts; keep them in sync until the
// shared contract exports them.

import type {
  AgentTask,
  AppSettings,
  ApprovalRequest,
  ChatMessage,
  DeviceStatus,
  HealthCheckItem,
  RemoteSettings,
  ScreenElement,
  StreamStats,
  WindowGeometry,
  WorkflowRun,
} from '@iphone-ai/shared';

export type SessionKind = 'desktop' | 'local-browser' | 'remote';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  canControl: boolean;
  remote: boolean;
}

export interface BootstrapResponse {
  status: DeviceStatus;
  settings: AppSettings;
  stream: StreamStats;
  pendingApprovals: ApprovalRequest[];
  activeTask: AgentTask | null;
  activeRun: WorkflowRun | null;
  session: SessionInfo;
  version: string;
}

/** Which backend listener served the page: the Mac-only one or the opt-in remote one. */
export type ListenerKind = 'local' | 'remote';

export interface HealthResponse {
  ok: true;
  version: string;
  listener: ListenerKind;
}

export interface HealthCheckResponse {
  ok: boolean;
  items: HealthCheckItem[];
  raw: string;
}

export interface DoctorCheck {
  name: string;
  status: string;
  detail: string;
  fix_hint?: string;
}

export interface DoctorResponse {
  checks: DoctorCheck[];
}

export interface DiagnosticsInfo {
  version: string;
  node: string;
  platform: string;
  arch: string;
  dataDir: string;
  mirroirBinary: string;
  mirroirVersion: string | null;
}

export type SettingsPane = 'screen-recording' | 'accessibility' | 'automation';

export interface DescribeResponse {
  elements: ScreenElement[];
  rawText: string;
  fingerprint: string;
  geometry: WindowGeometry | null;
}

export interface SendMessageResponse {
  message: ChatMessage;
  task: AgentTask;
}

export interface ClaudeCodeStatus {
  available: boolean;
  binaryPath: string | null;
  loggedIn: boolean;
  authMethod: string;
  detail: string;
}

export interface RecorderStatus {
  recording: boolean;
  name: string | null;
  startedAt: number | null;
  steps: number;
}

export interface RemoteSessionInfo {
  id: string;
  kind: SessionKind;
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  canControl: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
  current?: boolean;
}

export interface NetworkAddress {
  iface: string;
  address: string;
  tailscale: boolean;
}

export interface RemoteInfo {
  settings: RemoteSettings;
  listening: boolean;
  url: string | null;
  addresses: NetworkAddress[];
}

export interface PrivacyDeleteRequest {
  activity?: boolean;
  conversations?: boolean;
  screenshots?: boolean;
  approvals?: boolean;
}

export interface ExportSkillResponse {
  path: string;
  markdown: string;
}
