// WebSocket protocol between the backend and every UI (desktop window, local or remote browser).

import type { ActivityEvent } from './activity.js';
import type { AgentStep, AgentTask, ChatMessage } from './agent.js';
import type { ApprovalRequest } from './control.js';
import type { DeviceStatus, FrameMeta, StreamStats } from './device.js';
import type { AppSettings } from './settings.js';
import type { WorkflowRun } from './workflow.js';

export type ServerEvent =
  | { type: 'hello'; sessionId: string; serverVersion: string; remote: boolean; canControl: boolean }
  | { type: 'status'; status: DeviceStatus }
  | { type: 'frame'; meta: FrameMeta }
  | { type: 'stream_stats'; stats: StreamStats }
  | { type: 'activity'; event: ActivityEvent }
  | { type: 'chat_message'; message: ChatMessage }
  | { type: 'chat_delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'task_update'; task: AgentTask }
  | { type: 'task_step'; step: AgentStep }
  | { type: 'approval_requested'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; approval: ApprovalRequest }
  | { type: 'workflow_run'; run: WorkflowRun }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'stop_engaged'; reason: string; at: number }
  | { type: 'stop_released'; at: number }
  | { type: 'toast'; level: 'info' | 'success' | 'warning' | 'error'; title: string; message?: string };

export type ServerEventType = ServerEvent['type'];

export type ClientEvent =
  | { type: 'viewer'; visible: boolean; interactive: boolean }
  | { type: 'activity_ping' }
  | { type: 'ping'; t: number };
