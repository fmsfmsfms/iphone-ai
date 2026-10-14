// Contracts between backend services. The HTTP layer depends only on these
// interfaces; implementations live in ai/, automation/, remote/, device/.

import type {
  Actor,
  AgentStep,
  AgentTask,
  ChatMessage,
  Conversation,
  ProviderTestResult,
  StartTaskRequest,
  Workflow,
  WorkflowInput,
  WorkflowRun,
  WorkflowSuggestion,
} from '@iphone-ai/shared';

import type { ActivityLog } from './activity-log.js';
import type { EventHub } from './events.js';
import type { Logger } from './logger.js';
import type { AppPaths } from './paths.js';
import type { SettingsStore } from './settings-store.js';
import type { ScreenshotStore } from '../ai/screenshots.js';
import type { AiProvider } from '../ai/types.js';
import type { Database } from '../db/database.js';
import type { DeviceController } from '../device/device-controller.js';
import type { LiveCapture } from '../device/live-capture.js';
import type { ScreenStream } from '../device/screen-stream.js';
import type { MirroirManager } from '../mcp/mirroir-manager.js';
import type { ApprovalBroker } from '../policy/approvals.js';
import type { SecretStore } from '../security/secrets.js';

export interface ClaudeCodeStatus {
  /** The bundled Claude Code binary was found. */
  available: boolean;
  binaryPath: string | null;
  loggedIn: boolean;
  authMethod: string;
  detail: string;
}

/** Options for an AI task embedded in a workflow run (ai_task steps). */
export interface EmbeddedTaskOptions {
  instruction: string;
  maxActions?: number;
  workflowRunId: string;
  /** Lease already held by the workflow run; the AI task borrows it. */
  leaseId: string;
  signal: AbortSignal;
}

export interface EmbeddedTaskResult {
  success: boolean;
  verified: boolean;
  summary: string;
  taskId: string;
}

export interface AgentServiceApi {
  listConversations(): Conversation[];
  createConversation(title?: string): Conversation;
  deleteConversation(id: string): void;
  /** Removes messages and tasks but keeps the conversation. */
  clearConversation(id: string): void;
  getMessages(conversationId: string): ChatMessage[];
  getTasks(conversationId: string): AgentTask[];
  getTask(id: string): { task: AgentTask; steps: AgentStep[] } | null;
  activeTask(): AgentTask | null;
  /** Creates the user message and task, then runs the task in the background. */
  startTask(conversationId: string, request: StartTaskRequest, actor: Actor): Promise<{ message: ChatMessage; task: AgentTask }>;
  pauseTask(id: string): AgentTask;
  resumeTask(id: string): AgentTask;
  cancelTask(id: string, reason: string): AgentTask;
  /** Runs an AI task inside a workflow run (borrows the workflow's lease). */
  runEmbeddedTask(options: EmbeddedTaskOptions): Promise<EmbeddedTaskResult>;
  getProvider(providerId?: string | null): Promise<AiProvider>;
  testProvider(providerId: string): Promise<ProviderTestResult>;
  listProviderModels(providerId: string): Promise<string[]>;
  claudeCodeStatus(): Promise<ClaudeCodeStatus>;
}

export interface RecorderStatus {
  recording: boolean;
  name: string | null;
  startedAt: number | null;
  steps: number;
}

export interface WorkflowServiceApi {
  list(): Workflow[];
  get(id: string): Workflow | null;
  create(input: WorkflowInput): Workflow;
  update(id: string, input: WorkflowInput): Workflow;
  remove(id: string): void;
  run(id: string, actor: Actor): Promise<WorkflowRun>;
  pause(runId: string): WorkflowRun;
  resume(runId: string): WorkflowRun;
  stop(runId: string, reason: string): WorkflowRun;
  retry(runId: string, fromFailedStep: boolean, actor: Actor): Promise<WorkflowRun>;
  runs(workflowId?: string, limit?: number): WorkflowRun[];
  getRun(runId: string): WorkflowRun | null;
  activeRun(): WorkflowRun | null;
  suggest(goal: string, providerId?: string): Promise<WorkflowSuggestion>;
  /** Writes a SKILL.md export into Mirroir's project-local skills directory. */
  exportSkill(id: string): { path: string; markdown: string };
  startRecording(name: string): RecorderStatus;
  stopRecording(save: boolean): Workflow | null;
  recorderStatus(): RecorderStatus;
}

export interface RemoteSessionInfo {
  id: string;
  kind: 'desktop' | 'local-browser' | 'remote';
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
  /** 100.64.0.0/10 CGNAT range used by Tailscale. */
  tailscale: boolean;
}

export interface AppContext {
  version: string;
  sessionId: string;
  paths: AppPaths;
  log: Logger;
  db: Database;
  hub: EventHub;
  settings: SettingsStore;
  secrets: SecretStore;
  activity: ActivityLog;
  mirroir: MirroirManager;
  device: DeviceController;
  stream: ScreenStream;
  /** ScreenCaptureKit live frames (relayed on /ws/screen); unavailable without the capture helper. */
  live: LiveCapture;
  approvals: ApprovalBroker;
  screenshots: ScreenshotStore;
  agents: AgentServiceApi;
  workflows: WorkflowServiceApi;
}
