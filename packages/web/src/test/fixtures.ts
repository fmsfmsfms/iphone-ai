// Test-only data builders (never imported by production code).

import {
  createDefaultSettings,
  type AgentStep,
  type AgentTask,
  type AppSettings,
  type ApprovalRequest,
  type ChatMessage,
  type DeviceStatus,
  type FrameMeta,
  type StreamStats,
  type WorkflowRun,
} from '@iphone-ai/shared';

import type { BootstrapResponse } from '../lib/api-types';

export function makeStatus(overrides: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    server: {
      state: 'ready',
      binaryPath: '/opt/homebrew/bin/mirroir',
      pid: 4242,
      version: '0.40.1',
      protocolVersion: '2025-11-25',
      startedAt: 1_000,
      restartCount: 0,
      lastError: null,
      tools: [],
      permissionFile: null,
    },
    mirroring: {
      state: 'connected',
      rawStatus: 'Connected — mirroring active (window: 410x890, pos=(1200,80), portrait)',
      target: 'iphone',
      geometry: { widthPt: 410, heightPt: 890, orientation: 'portrait', geometryId: '410x890', observedAt: 1_000 },
      checkedAt: 1_000,
    },
    permissions: { screenRecording: 'granted', accessibility: 'granted', source: 'doctor', checkedAt: 1_000 },
    controlOwner: 'none',
    stopLatched: false,
    stopReason: null,
    queueDepth: 0,
    actionInFlight: false,
    lastFocusSteal: null,
    ...overrides,
  };
}

export function makeSettings(mutate?: (s: AppSettings) => void): AppSettings {
  const settings = createDefaultSettings();
  mutate?.(settings);
  return settings;
}

export function makeStream(overrides: Partial<StreamStats> = {}): StreamStats {
  return {
    mode: 'polling-screenshots',
    running: true,
    targetFps: 2,
    measuredFps: 1.9,
    avgLatencyMs: 210,
    lastFrameAt: 1_000,
    pausedReason: null,
    viewers: 1,
    consecutiveErrors: 0,
    lastError: null,
    ...overrides,
  };
}

export function makeFrame(seq: number, overrides: Partial<FrameMeta> = {}): FrameMeta {
  return {
    seq,
    capturedAt: 1_000 + seq,
    latencyMs: 200,
    widthPx: 820,
    heightPx: 1780,
    mimeType: 'image/png',
    pxPerPt: 2,
    geometry: { widthPt: 410, heightPt: 890, orientation: 'portrait', geometryId: '410x890', observedAt: 1_000 },
    ...overrides,
  };
}

export function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task_1',
    conversationId: 'conv_1',
    instruction: 'Open Settings',
    status: 'running',
    providerId: 'claude-api',
    providerLabel: 'Claude (Anthropic API)',
    model: 'claude-opus-5-5',
    mode: 'assisted',
    createdAt: 1_000,
    startedAt: 1_001,
    endedAt: null,
    actionsUsed: 2,
    maxActions: 25,
    currentActivity: 'Looking at the screen',
    outcome: null,
    error: null,
    ...overrides,
  };
}

export function makeStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: 'step_1',
    taskId: 'task_1',
    index: 0,
    type: 'tool_call',
    title: 'Tap “Settings”',
    detail: null,
    tool: { name: 'tap', args: { x: 100, y: 200 }, ok: true, result: 'Tapped at (100, 200)', durationMs: 120 },
    screenshotId: null,
    createdAt: 1_002,
    ...overrides,
  };
}

export function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'appr_1',
    createdAt: 1_000,
    expiresAt: Date.now() + 120_000,
    status: 'pending',
    actor: 'ai',
    taskId: 'task_1',
    workflowRunId: null,
    summary: 'Tap “Send” in Messages',
    action: { tool: 'tap', args: { x: 300, y: 820 } },
    risk: 'high',
    reasons: ['Sending messages requires approval'],
    frameSeq: 7,
    decidedAt: null,
    decidedBy: null,
    note: null,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg_1',
    conversationId: 'conv_1',
    role: 'user',
    text: 'Open Settings',
    taskId: null,
    createdAt: 1_000,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run_1',
    workflowId: 'wf_1',
    workflowName: 'Morning check',
    status: 'running',
    startedAt: 1_000,
    endedAt: null,
    currentStepIndex: 0,
    steps: [],
    error: null,
    retryOf: null,
    ...overrides,
  };
}

export function makeBootstrap(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    status: makeStatus(),
    settings: makeSettings(),
    stream: makeStream(),
    pendingApprovals: [],
    activeTask: null,
    activeRun: null,
    session: { id: 'sess_1', kind: 'desktop', canControl: true, remote: false },
    version: '0.1.0',
    ...overrides,
  };
}
