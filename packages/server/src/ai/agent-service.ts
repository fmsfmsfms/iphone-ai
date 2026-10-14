// Conversations and AI tasks: persistence, streaming events, lifecycle
// (start, pause, resume, cancel, emergency stop) and outcome reporting.

import {
  TERMINAL_TASK_STATUSES,
  type Actor,
  type AgentStep,
  type AgentTask,
  type ChatMessage,
  type Conversation,
  type ProviderConfig,
  type ProviderTestResult,
  type StartTaskRequest,
  type TaskStatus,
} from '@iphone-ai/shared';

import type { ActivityLog } from '../core/activity-log.js';
import type { EventHub } from '../core/events.js';
import { newId } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { AppPaths } from '../core/paths.js';
import type {
  AgentServiceApi,
  ClaudeCodeStatus,
  EmbeddedTaskOptions,
  EmbeddedTaskResult,
} from '../core/services.js';
import type { SettingsStore } from '../core/settings-store.js';
import { fromJson, toJson, type Database } from '../db/database.js';
import { DeviceError, type DeviceController, type Lease } from '../device/device-controller.js';
import type { ApprovalBroker } from '../policy/approvals.js';
import { nextUncommittedTyping, type TypingActionEvent } from '../policy/typing.js';
import { providerSecretAccount, type SecretStore } from '../security/secrets.js';
import { agentSystemPrompt, screenSummaryPrompt } from './agent/prompts.js';
import { describeProviderError, runAgent, type RunOutcome } from './agent/runner.js';
import { AgentToolkit, TaskAbortedError, type FinishResult } from './agent/toolkit.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { claudeCodeAuthStatus, resolveClaudeCodeBinary } from './providers/claude-agent-sdk.js';
import { ProviderFactory } from './providers/factory.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';
import type { ScreenshotStore } from './screenshots.js';
import { ProviderError, type AiProvider, type ModelContent } from './types.js';

export interface AgentServiceDeps {
  db: Database;
  settings: SettingsStore;
  secrets: SecretStore;
  hub: EventHub;
  activity: ActivityLog;
  device: DeviceController;
  approvals: ApprovalBroker;
  screenshots: ScreenshotStore;
  paths: AppPaths;
  log: Logger;
  /** Test hook: builds providers instead of the real factory (scripted models in tests). */
  buildProvider?: (config: ProviderConfig) => Promise<AiProvider>;
}

interface ActiveTask {
  task: AgentTask;
  controller: AbortController;
  lease: Lease | null;
  /** True when the lease belongs to a workflow run (embedded task). */
  borrowedLease: boolean;
  paused: boolean;
  resumeWaiters: (() => void)[];
  stepIndex: number;
  messageId: string | null;
  streamedText: string;
  publishTimer: NodeJS.Timeout | null;
}

interface TaskRow {
  id: string;
  conversation_id: string;
  instruction: string;
  status: string;
  provider_id: string;
  provider_label: string;
  model: string;
  mode: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  actions_used: number;
  max_actions: number;
  current_activity: string | null;
  outcome_json: string | null;
  error: string | null;
}

const WORKFLOW_CONVERSATION_ID = 'conv_workflow_ai_steps';
const KNOWN_CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];

export class AgentService implements AgentServiceApi {
  private active: ActiveTask | null = null;
  /** A task is being set up (provider build); the slot is taken before the first await. */
  private starting = false;
  /** Text typed on the phone (by anyone) that has not been sent or submitted yet. */
  private uncommittedTyping = false;
  private readonly factory: Pick<ProviderFactory, 'build' | 'invalidate'>;
  private readonly log: Logger;

  constructor(private readonly deps: AgentServiceDeps) {
    this.log = deps.log.child('agent');
    const real = new ProviderFactory(deps.secrets, deps.paths, deps.log);
    this.factory = deps.buildProvider ? { build: deps.buildProvider, invalidate: () => undefined } : real;
    deps.settings.onChange((next, previous) => {
      this.factory.invalidate();
      // Lowering control to Observe Only withdraws every pending AI / workflow approval card.
      if (next.permissions.controlMode === 'observe' && previous.permissions.controlMode !== 'observe') {
        deps.approvals.cancelWhere((r) => r.actor === 'ai' || r.actor === 'workflow', 'Control mode changed to Observe Only');
      }
    });
    // The emergency stop aborts tasks that hold no lease too (Observe Only tasks).
    deps.device.on('stop', () => {
      if (this.active) this.active.controller.abort(new TaskAbortedError('Stopped by the emergency stop.', 'stopped'));
    });
    // Drafts typed by any actor (an earlier task, a workflow step, the user) stay "uncommitted"
    // until sent with approval, so a later task cannot send them with an unlabeled tap.
    deps.device.on('action', (event: TypingActionEvent) => {
      this.uncommittedTyping = nextUncommittedTyping(this.uncommittedTyping, event);
    });
    this.recoverInterruptedTasks();
  }

  /** Tasks left "running" by a crash or quit are marked failed on startup. */
  private recoverInterruptedTasks(): void {
    const now = Date.now();
    this.deps.db.run(
      `UPDATE tasks SET status = 'failed', ended_at = ?, error = 'Interrupted: iPhone AI was closed while the task was running.'
       WHERE status IN ('queued', 'running', 'paused', 'awaiting_approval')`,
      now,
    );
  }

  // ───────────────────────────── conversations ─────────────────────────────

  listConversations(): Conversation[] {
    return this.deps.db
      .all<{ id: string; title: string; created_at: number; updated_at: number }>(
        'SELECT * FROM conversations WHERE id != ? ORDER BY updated_at DESC',
        WORKFLOW_CONVERSATION_ID,
      )
      .map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  createConversation(title?: string): Conversation {
    const now = Date.now();
    const conversation: Conversation = { id: newId('conv'), title: title?.trim() || 'New conversation', createdAt: now, updatedAt: now };
    this.deps.db.run(
      'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      conversation.id,
      conversation.title,
      now,
      now,
    );
    return conversation;
  }

  deleteConversation(id: string): void {
    this.assertNotBusy(id);
    this.deps.db.run('DELETE FROM conversations WHERE id = ?', id);
  }

  clearConversation(id: string): void {
    this.assertNotBusy(id);
    this.deps.db.transaction(() => {
      this.deps.db.run('DELETE FROM chat_messages WHERE conversation_id = ?', id);
      this.deps.db.run('DELETE FROM tasks WHERE conversation_id = ?', id);
      this.deps.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Date.now(), id);
    });
  }

  private assertNotBusy(conversationId: string): void {
    if (this.active && this.active.task.conversationId === conversationId) {
      throw new DeviceError('A task is running in this conversation. Cancel it first.', 'lease_conflict');
    }
  }

  getMessages(conversationId: string): ChatMessage[] {
    return this.deps.db
      .all<{ id: string; conversation_id: string; role: string; text: string; task_id: string | null; created_at: number }>(
        'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC',
        conversationId,
      )
      .map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        role: r.role as ChatMessage['role'],
        text: this.active?.messageId === r.id ? this.active.streamedText : r.text,
        taskId: r.task_id,
        createdAt: r.created_at,
        ...(this.active?.messageId === r.id ? { streaming: true } : {}),
      }));
  }

  getTasks(conversationId: string): AgentTask[] {
    return this.deps.db
      .all<TaskRow>('SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at ASC', conversationId)
      .map((r) => (this.active?.task.id === r.id ? this.active.task : rowToTask(r)));
  }

  getTask(id: string): { task: AgentTask; steps: AgentStep[] } | null {
    const row = this.deps.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) return null;
    const steps = this.deps.db
      .all<{ id: string; task_id: string; idx: number; type: string; title: string; detail: string | null; tool_json: string | null; screenshot_id: string | null; created_at: number }>(
        'SELECT * FROM task_steps WHERE task_id = ? ORDER BY idx ASC',
        id,
      )
      .map((s) => ({
        id: s.id,
        taskId: s.task_id,
        index: s.idx,
        type: s.type as AgentStep['type'],
        title: s.title,
        detail: s.detail,
        tool: s.tool_json ? fromJson<AgentStep['tool']>(s.tool_json, null) : null,
        screenshotId: s.screenshot_id,
        createdAt: s.created_at,
      }));
    return { task: this.active?.task.id === id ? this.active.task : rowToTask(row), steps };
  }

  activeTask(): AgentTask | null {
    return this.active?.task ?? null;
  }

  // ───────────────────────────── providers ─────────────────────────────

  private providerConfig(providerId?: string | null): ProviderConfig {
    const settings = this.deps.settings.get();
    const id = providerId || settings.ai.activeProviderId;
    const config = settings.ai.providers.find((p) => p.id === id);
    if (!config) throw new ProviderError(`Unknown AI provider "${id}".`, false, 'config');
    return config;
  }

  async getProvider(providerId?: string | null): Promise<AiProvider> {
    return this.factory.build(this.providerConfig(providerId));
  }

  async testProvider(providerId: string): Promise<ProviderTestResult> {
    const config = this.providerConfig(providerId);
    let provider: AiProvider;
    try {
      provider = await this.factory.build({ ...config, enabled: true });
    } catch (err) {
      return { ok: false, latencyMs: 0, message: describeProviderError(err), model: null, supportsTools: null, supportsVision: null };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 30000));
    try {
      const result = await provider.test(controller.signal);
      this.deps.activity.record({
        category: 'settings',
        type: 'provider.tested',
        actor: 'user',
        severity: result.ok ? 'info' : 'warning',
        summary: `Tested ${config.label}: ${result.ok ? 'connected' : 'failed'} — ${result.message}`,
      });
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async listProviderModels(providerId: string): Promise<string[]> {
    const config = this.providerConfig(providerId);
    if (config.kind === 'claude-agent-sdk') return KNOWN_CLAUDE_MODELS;
    const provider = await this.factory.build({ ...config, enabled: true, model: config.model || 'placeholder' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      if (provider instanceof OpenAiCompatibleProvider || provider instanceof AnthropicProvider) {
        return (await provider.listModels(controller.signal)).sort();
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async claudeCodeStatus(): Promise<ClaudeCodeStatus> {
    const binary = resolveClaudeCodeBinary();
    if (!binary) {
      return { available: false, binaryPath: null, loggedIn: false, authMethod: 'none', detail: 'The Claude Code engine is not bundled in this build.' };
    }
    try {
      const key = await this.deps.secrets.get(providerSecretAccount('claude-code')).catch(() => null);
      const status = await claudeCodeAuthStatus(binary, key);
      return {
        available: true,
        binaryPath: binary,
        loggedIn: status.loggedIn,
        authMethod: status.authMethod,
        detail: status.loggedIn
          ? `Signed in via ${status.authMethod}${status.subscriptionType ? ` (${status.subscriptionType})` : ''}.`
          : 'Not signed in. Run "claude" in Terminal and sign in, or store an API key for this provider.',
      };
    } catch (err) {
      return { available: true, binaryPath: binary, loggedIn: false, authMethod: 'unknown', detail: describeProviderError(err) };
    }
  }

  // ───────────────────────────── tasks ─────────────────────────────

  async startTask(conversationId: string, request: StartTaskRequest, actor: Actor): Promise<{ message: ChatMessage; task: AgentTask }> {
    const conversation = this.deps.db.get<{ id: string; title: string }>('SELECT id, title FROM conversations WHERE id = ?', conversationId);
    if (!conversation) throw new DeviceError('Conversation not found.', 'not_authorized', 404);
    this.assertCanStart();
    this.assertScreenAvailable();

    const config = this.providerConfig(request.providerId);
    const provider = await this.buildReserved(config);
    // State may have changed while the provider was being built (Keychain read).
    this.assertCanStart();
    const settings = this.deps.settings.get();
    const maxActions = Math.min(request.maxActions ?? settings.ai.maxActionsPerTask, settings.ai.maxActionsPerTask);

    const now = Date.now();
    const message: ChatMessage = { id: newId('msg'), conversationId, role: 'user', text: request.text, taskId: null, createdAt: now };
    const task: AgentTask = {
      id: newId('task'),
      conversationId,
      instruction: request.text,
      status: 'queued',
      providerId: config.id,
      providerLabel: config.label,
      model: config.model,
      mode: settings.permissions.controlMode,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      actionsUsed: 0,
      maxActions,
      currentActivity: null,
      outcome: null,
      error: null,
    };
    message.taskId = task.id;
    this.deps.db.transaction(() => {
      this.insertMessage(message);
      this.insertTask(task);
      if (conversation.title === 'New conversation') {
        this.deps.db.run('UPDATE conversations SET title = ? WHERE id = ?', truncate(request.text, 60), conversationId);
      }
      this.deps.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, conversationId);
    });
    this.deps.hub.publish({ type: 'chat_message', message });
    this.deps.hub.publish({ type: 'task_update', task });

    const active: ActiveTask = {
      task,
      controller: new AbortController(),
      lease: null,
      borrowedLease: false,
      paused: false,
      resumeWaiters: [],
      stepIndex: 0,
      messageId: null,
      streamedText: '',
      publishTimer: null,
    };
    this.active = active;
    this.deps.activity.record({
      category: 'ai',
      type: 'task.started',
      actor,
      summary: `AI task started with ${config.label} (${config.model || 'default model'}): “${truncate(request.text, 120)}”`,
      taskId: task.id,
      detail: { provider: config.id, model: config.model, mode: task.mode, maxActions },
    });
    void this.execute(active, provider, config, conversationId).catch((err: unknown) => {
      this.log.error('Task crashed', { error: err instanceof Error ? err.stack ?? err.message : String(err) });
    });
    return { message, task };
  }

  /** Only one AI task at a time, and never while another controller holds the phone. */
  private assertCanStart(): void {
    if (this.deps.device.isStopLatched) throw new DeviceError('Emergency stop is engaged. Re-arm control first.', 'stop_latched');
    if (this.active || this.starting) throw new DeviceError('Another AI task is running. Wait for it or cancel it first.', 'lease_conflict');
    const lease = this.deps.device.currentLease;
    if (lease) throw new DeviceError(`${lease.label} is controlling the iPhone.`, 'lease_conflict');
  }

  /** Builds the provider while holding the start slot, so overlapping starts cannot both pass the busy check. */
  private async buildReserved(config: ProviderConfig): Promise<AiProvider> {
    this.starting = true;
    try {
      return await this.factory.build(config);
    } finally {
      this.starting = false;
    }
  }

  private assertScreenAvailable(): void {
    const status = this.deps.device.getStatus();
    if (status.server.state !== 'ready') throw new DeviceError('The Mirroir MCP server is not running.', 'mcp_unavailable', 503);
    if (status.permissions.screenRecording !== 'granted') {
      throw new DeviceError('Screen Recording permission is not confirmed for iPhone AI, so the AI cannot see the screen.', 'screen_capture_unavailable', 412);
    }
    if (status.mirroring.state === 'paused') throw new DeviceError('iPhone Mirroring is paused. Unlock the iPhone or click Resume.', 'paused');
    if (status.mirroring.state !== 'connected') throw new DeviceError('iPhone Mirroring is not connected.', 'not_connected');
  }

  private async execute(active: ActiveTask, provider: AiProvider, config: ProviderConfig, conversationId: string, embedded?: EmbeddedTaskOptions): Promise<RunOutcome | null> {
    const { task, controller } = active;
    const settings = this.deps.settings.get();
    const mode = embedded ? settings.permissions.controlMode : task.mode;
    let deadline: NodeJS.Timeout | null = null;
    let outcome: RunOutcome | null = null;
    let toolkit: AgentToolkit | null = null;
    let failure: string | null = null;
    let finalStatus: TaskStatus = 'failed';
    const onEmbeddedAbort = () => controller.abort(new TaskAbortedError('The workflow run was stopped.', 'stopped'));

    try {
      // Control lease: an AI task that may act holds exclusive control.
      if (embedded) {
        active.lease = this.deps.device.currentLease;
        active.borrowedLease = true;
        if (!active.lease || active.lease.id !== embedded.leaseId) throw new DeviceError('The workflow no longer holds control.', 'lease_conflict');
        // A Stop that arrived while the provider was being built fired before this listener existed.
        if (embedded.signal.aborted) throw new TaskAbortedError('The workflow run was stopped.', 'stopped');
        embedded.signal.addEventListener('abort', onEmbeddedAbort, { once: true });
      } else if (mode !== 'observe') {
        active.lease = this.deps.device.acquireLease('ai', `AI task “${truncate(task.instruction, 40)}”`);
      }
      if (active.lease) {
        const lease = active.lease;
        if (lease.signal.aborted) throw new TaskAbortedError('Stopped by the emergency stop.', 'stopped');
        lease.signal.addEventListener('abort', () => controller.abort(new TaskAbortedError('Stopped by the emergency stop.', 'stopped')), { once: true });
      }
      deadline = setTimeout(
        () => controller.abort(new TaskAbortedError(`Time limit reached (${settings.ai.maxTaskDurationSec}s).`, 'timeout')),
        settings.ai.maxTaskDurationSec * 1000,
      );
      deadline.unref();

      this.updateTask(active, { status: 'running', startedAt: Date.now(), currentActivity: 'Starting' });
      if (!embedded) active.messageId = this.startAssistantMessage(active, conversationId);

      const visionProvider = !config.vision ? await this.visionHelper() : null;
      throwIfAborted(controller.signal);
      toolkit = new AgentToolkit(
        {
          device: this.deps.device,
          approvals: this.deps.approvals,
          settings: this.deps.settings,
          activity: this.deps.activity,
          screenshots: this.deps.screenshots,
        },
        {
          taskId: task.id,
          leaseId: active.lease?.id ?? null,
          workflowRunId: embedded?.workflowRunId ?? null,
          signal: controller.signal,
          vision: config.vision,
          maxActions: task.maxActions,
          mode,
          ...(visionProvider
            ? {
                describeImage: (data: string, mimeType: string, signal: AbortSignal) =>
                  visionProvider.complete({
                    system: screenSummaryPrompt(),
                    content: [
                      { type: 'image', mimeType, data },
                      { type: 'text', text: 'Describe this iPhone screen.' },
                    ],
                    signal,
                    maxTokens: 600,
                  }),
              }
            : {}),
          addStep: (step) => this.addStep(active, step),
          setActivity: (text) => this.updateTask(active, { currentActivity: text }, true),
          setAwaitingApproval: (waiting) => this.updateTask(active, { status: waiting ? 'awaiting_approval' : active.paused ? 'paused' : 'running' }),
          waitIfPaused: () => this.waitIfPaused(active),
          onActionsUsed: (count) => this.updateTask(active, { actionsUsed: count }),
          uncommittedTyping: () => this.uncommittedTyping,
        },
      );

      const first = await toolkit.observe({ title: 'Looked at the screen' });
      throwIfAborted(controller.signal);
      const prompt: ModelContent[] = [
        { type: 'text', text: `${embedded ? '' : this.conversationContext(conversationId, task.id)}Instruction: ${task.instruction}\n\nCurrent screen:` },
        ...first.content,
      ];
      const system = agentSystemPrompt({ mode, maxActions: task.maxActions, vision: config.vision, tools: toolkit.toolNames() });
      outcome = await runAgent({
        provider,
        toolkit,
        system,
        prompt,
        signal: controller.signal,
        maxTurns: task.maxActions * 2 + 8,
        callbacks: {
          onText: (delta) => this.appendText(active, delta),
          onReasoning: () => undefined,
          onTurnEnd: (reasoning) => {
            if (reasoning.trim()) {
              this.addStep(active, { type: 'reasoning', title: 'Reasoning', detail: truncate(reasoning.trim(), 4000), tool: null, screenshotId: null });
            }
            if (active.streamedText && !active.streamedText.endsWith('\n\n')) this.appendText(active, '\n\n');
          },
        },
      });
      const result = toolkit.result;
      // Cancelled / stopped before reporting a result: record why, not "stopped without a result".
      if (!result) throwIfAborted(controller.signal);
      if (result) finalStatus = result.status === 'success' ? 'completed' : 'failed';
      else {
        finalStatus = 'failed';
        failure =
          outcome.stop === 'max_turns'
            ? 'The task reached its step limit before finishing.'
            : outcome.stop === 'refusal'
              ? `The model declined: ${outcome.error ?? ''}`
              : outcome.stop === 'error'
                ? outcome.error ?? 'The AI provider reported an error.'
                : 'The AI stopped without reporting a result.';
      }
    } catch (err) {
      if (err instanceof TaskAbortedError || controller.signal.aborted) {
        const reason = err instanceof TaskAbortedError ? err : controller.signal.reason instanceof TaskAbortedError ? controller.signal.reason : null;
        finalStatus = reason?.reason === 'cancelled' ? 'cancelled' : reason?.reason === 'stopped' ? 'stopped' : 'failed';
        failure = reason?.message ?? 'The task was stopped.';
      } else {
        finalStatus = 'failed';
        failure = describeProviderError(err);
        this.addStep(active, { type: 'error', title: 'The task failed', detail: failure, tool: null, screenshotId: null });
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      if (embedded) embedded.signal.removeEventListener('abort', onEmbeddedAbort);
      if (active.lease && !active.borrowedLease) active.lease.release();
    }

    const result = toolkit?.result ?? null;
    const outcomeRecord = result
      ? { success: result.status === 'success', verified: result.verified, summary: result.summary }
      : { success: false, verified: false, summary: failure ?? 'The task did not finish.' };
    this.updateTask(active, {
      status: finalStatus,
      endedAt: Date.now(),
      currentActivity: null,
      outcome: outcomeRecord,
      error: finalStatus === 'completed' ? null : failure ?? (result?.status === 'needs_user' ? 'Needs your help.' : result?.summary ?? null),
    });
    if (!embedded) this.finishAssistantMessage(active, result, failure, finalStatus);
    this.deps.activity.record({
      category: 'ai',
      type: `task.${finalStatus}`,
      actor: 'ai',
      severity: finalStatus === 'completed' ? 'info' : 'warning',
      summary: taskSummaryLine(finalStatus, result, failure),
      taskId: task.id,
      workflowRunId: embedded?.workflowRunId ?? null,
      success: finalStatus === 'completed',
      durationMs: task.startedAt ? Date.now() - task.startedAt : null,
      detail: {
        actionsUsed: task.actionsUsed,
        verified: result?.verified ?? false,
        evidence: result?.evidence ?? [],
        missingEvidence: result?.missingEvidence ?? [],
        stop: outcome?.stop ?? null,
      },
    });
    if (active.publishTimer) clearTimeout(active.publishTimer);
    if (this.active === active) this.active = null;
    return outcome;
  }

  private async visionHelper(): Promise<AiProvider | null> {
    const settings = this.deps.settings.get();
    if (!settings.ai.visionProviderId) return null;
    const config = settings.ai.providers.find((p) => p.id === settings.ai.visionProviderId);
    if (!config || !config.vision) return null;
    try {
      return await this.factory.build(config);
    } catch {
      return null;
    }
  }

  private conversationContext(conversationId: string, currentTaskId: string): string {
    const rows = this.deps.db.all<{ role: string; text: string; task_id: string | null }>(
      'SELECT role, text, task_id FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 12',
      conversationId,
    );
    const prior = rows.reverse().filter((r) => r.task_id !== currentTaskId && r.text.trim());
    if (prior.length === 0) return '';
    const lines = prior.map((r) => `${r.role === 'user' ? 'User' : 'Assistant'}: ${truncate(r.text.replace(/\s+/g, ' '), 400)}`);
    return `Earlier in this conversation (for context only):\n${lines.join('\n')}\n\n`;
  }

  async runEmbeddedTask(options: EmbeddedTaskOptions): Promise<EmbeddedTaskResult> {
    if (this.active || this.starting) throw new DeviceError('Another AI task is running.', 'lease_conflict');
    this.ensureWorkflowConversation();
    const config = this.providerConfig(null);
    const provider = await this.buildReserved(config);
    if (this.active) throw new DeviceError('Another AI task is running.', 'lease_conflict');
    const settings = this.deps.settings.get();
    const now = Date.now();
    const task: AgentTask = {
      id: newId('task'),
      conversationId: WORKFLOW_CONVERSATION_ID,
      instruction: options.instruction,
      status: 'queued',
      providerId: config.id,
      providerLabel: config.label,
      model: config.model,
      mode: settings.permissions.controlMode,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      actionsUsed: 0,
      maxActions: Math.min(options.maxActions ?? settings.ai.maxActionsPerTask, settings.ai.maxActionsPerTask),
      currentActivity: null,
      outcome: null,
      error: null,
    };
    this.insertTask(task);
    const active: ActiveTask = {
      task,
      controller: new AbortController(),
      lease: null,
      borrowedLease: true,
      paused: false,
      resumeWaiters: [],
      stepIndex: 0,
      messageId: null,
      streamedText: '',
      publishTimer: null,
    };
    this.active = active;
    await this.execute(active, provider, config, WORKFLOW_CONVERSATION_ID, options);
    const outcome = active.task.outcome;
    return {
      success: active.task.status === 'completed' && (outcome?.success ?? false),
      verified: outcome?.verified ?? false,
      summary: outcome?.summary ?? active.task.error ?? 'The AI step did not finish.',
      taskId: task.id,
    };
  }

  private ensureWorkflowConversation(): void {
    const now = Date.now();
    this.deps.db.run(
      'INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      WORKFLOW_CONVERSATION_ID,
      'AI steps in automations',
      now,
      now,
    );
  }

  pauseTask(id: string): AgentTask {
    const active = this.requireActive(id);
    if (!active.paused) {
      active.paused = true;
      if (active.lease && !active.borrowedLease) this.deps.device.setLeasePaused(active.lease.id, true);
      this.updateTask(active, { status: 'paused', currentActivity: 'Paused — you can use manual control' });
      this.deps.activity.record({ category: 'ai', type: 'task.paused', actor: 'user', summary: 'AI task paused.', taskId: id });
    }
    return active.task;
  }

  resumeTask(id: string): AgentTask {
    const active = this.requireActive(id);
    if (active.paused) {
      active.paused = false;
      if (active.lease && !active.borrowedLease) this.deps.device.setLeasePaused(active.lease.id, false);
      this.updateTask(active, { status: 'running', currentActivity: null });
      for (const resolve of active.resumeWaiters.splice(0)) resolve();
      this.deps.activity.record({ category: 'ai', type: 'task.resumed', actor: 'user', summary: 'AI task resumed.', taskId: id });
    }
    return active.task;
  }

  cancelTask(id: string, reason: string): AgentTask {
    const active = this.active?.task.id === id ? this.active : null;
    if (!active) {
      const row = this.getTask(id);
      if (!row) throw new DeviceError('Task not found.', 'not_authorized', 404);
      return row.task;
    }
    active.controller.abort(new TaskAbortedError(reason || 'Cancelled by you.', 'cancelled'));
    for (const resolve of active.resumeWaiters.splice(0)) resolve();
    return active.task;
  }

  private requireActive(id: string): ActiveTask {
    if (!this.active || this.active.task.id !== id) throw new DeviceError('This task is not running.', 'not_authorized', 409);
    return this.active;
  }

  /**
   * Resolves on resume — or on abort, so a stopped/cancelled paused task wakes up and ends.
   * An embedded task also waits while the workflow's lease is paused (a pause
   * that arrived before the task existed could not pause the task itself).
   */
  private async waitIfPaused(active: ActiveTask): Promise<void> {
    for (;;) {
      if (active.controller.signal.aborted) return;
      if (active.paused) {
        await this.waitForResume(active);
        continue;
      }
      if (active.borrowedLease && active.lease?.paused) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 200);
          function done() {
            clearTimeout(timer);
            active.controller.signal.removeEventListener('abort', done);
            resolve();
          }
          active.controller.signal.addEventListener('abort', done, { once: true });
        });
        continue;
      }
      return;
    }
  }

  private waitForResume(active: ActiveTask): Promise<void> {
    if (!active.paused || active.controller.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => resolve();
      active.controller.signal.addEventListener('abort', onAbort, { once: true });
      active.resumeWaiters.push(() => {
        active.controller.signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  // ───────────────────────────── persistence & events ─────────────────────────────

  private updateTask(active: ActiveTask, patch: Partial<AgentTask>, debounce = false): void {
    Object.assign(active.task, patch);
    const t = active.task;
    this.deps.db.run(
      `UPDATE tasks SET status = ?, started_at = ?, ended_at = ?, actions_used = ?, current_activity = ?, outcome_json = ?, error = ? WHERE id = ?`,
      t.status,
      t.startedAt,
      t.endedAt,
      t.actionsUsed,
      t.currentActivity,
      t.outcome ? toJson(t.outcome) : null,
      t.error,
      t.id,
    );
    if (debounce) {
      if (active.publishTimer) return;
      active.publishTimer = setTimeout(() => {
        active.publishTimer = null;
        this.deps.hub.publish({ type: 'task_update', task: { ...active.task } });
      }, 150);
      return;
    }
    this.deps.hub.publish({ type: 'task_update', task: { ...t } });
  }

  private addStep(active: ActiveTask, step: Omit<AgentStep, 'id' | 'taskId' | 'index' | 'createdAt'>): void {
    const full: AgentStep = { ...step, id: newId('step'), taskId: active.task.id, index: active.stepIndex++, createdAt: Date.now() };
    this.deps.db.run(
      'INSERT INTO task_steps (id, task_id, idx, type, title, detail, tool_json, screenshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      full.id,
      full.taskId,
      full.index,
      full.type,
      full.title,
      full.detail,
      full.tool ? toJson(full.tool) : null,
      full.screenshotId,
      full.createdAt,
    );
    this.deps.hub.publish({ type: 'task_step', step: full });
  }

  private startAssistantMessage(active: ActiveTask, conversationId: string): string {
    const message: ChatMessage = {
      id: newId('msg'),
      conversationId,
      role: 'assistant',
      text: '',
      taskId: active.task.id,
      createdAt: Date.now(),
      streaming: true,
    };
    this.insertMessage(message);
    this.deps.hub.publish({ type: 'chat_message', message });
    return message.id;
  }

  private appendText(active: ActiveTask, delta: string): void {
    if (!active.messageId || !delta) return;
    active.streamedText += delta;
    this.deps.hub.publish({ type: 'chat_delta', conversationId: active.task.conversationId, messageId: active.messageId, delta });
  }

  private finishAssistantMessage(active: ActiveTask, result: FinishResult | null, failure: string | null, status: TaskStatus): void {
    if (!active.messageId) return;
    const parts: string[] = [];
    const commentary = active.streamedText.trim();
    if (result?.summary && !commentary.includes(result.summary.slice(0, 40))) parts.push(result.summary);
    if (commentary) parts.unshift(commentary);
    if (!result && failure) parts.push(failure);
    if (parts.length === 0) parts.push(statusSentence(status));
    const text = parts.join('\n\n');
    this.deps.db.run('UPDATE chat_messages SET text = ? WHERE id = ?', text, active.messageId);
    const message: ChatMessage = {
      id: active.messageId,
      conversationId: active.task.conversationId,
      role: 'assistant',
      text,
      taskId: active.task.id,
      createdAt: active.task.createdAt,
      streaming: false,
    };
    active.messageId = null;
    active.streamedText = '';
    this.deps.hub.publish({ type: 'chat_message', message });
  }

  private insertMessage(m: ChatMessage): void {
    this.deps.db.run(
      'INSERT INTO chat_messages (id, conversation_id, role, text, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      m.id,
      m.conversationId,
      m.role,
      m.text,
      m.taskId,
      m.createdAt,
    );
  }

  private insertTask(t: AgentTask): void {
    this.deps.db.run(
      `INSERT INTO tasks (id, conversation_id, instruction, status, provider_id, provider_label, model, mode, created_at, started_at, ended_at, actions_used, max_actions, current_activity, outcome_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id,
      t.conversationId,
      t.instruction,
      t.status,
      t.providerId,
      t.providerLabel,
      t.model,
      t.mode,
      t.createdAt,
      t.startedAt,
      t.endedAt,
      t.actionsUsed,
      t.maxActions,
      t.currentActivity,
      null,
      null,
    );
  }
}

function rowToTask(r: TaskRow): AgentTask {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    instruction: r.instruction,
    status: r.status as TaskStatus,
    providerId: r.provider_id,
    providerLabel: r.provider_label,
    model: r.model,
    mode: r.mode as AgentTask['mode'],
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    actionsUsed: r.actions_used,
    maxActions: r.max_actions,
    currentActivity: TERMINAL_TASK_STATUSES.includes(r.status as TaskStatus) ? null : r.current_activity,
    outcome: r.outcome_json ? fromJson<AgentTask['outcome']>(r.outcome_json, null) : null,
    error: r.error,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new TaskAbortedError('The task was stopped.', 'cancelled');
}

function statusSentence(status: TaskStatus): string {
  switch (status) {
    case 'completed':
      return 'Done.';
    case 'cancelled':
      return 'Cancelled.';
    case 'stopped':
      return 'Stopped by the emergency stop.';
    default:
      return 'The task did not finish.';
  }
}

function taskSummaryLine(status: TaskStatus, result: FinishResult | null, failure: string | null): string {
  if (status === 'completed' && result) {
    return `AI task completed${result.verified ? ' and verified on screen' : ' (not verified on screen)'}: ${truncate(result.summary, 200)}`;
  }
  if (status === 'cancelled') return 'AI task cancelled.';
  if (status === 'stopped') return 'AI task stopped by the emergency stop.';
  if (result?.status === 'needs_user') return `AI task needs your help: ${truncate(result.summary, 200)}`;
  return `AI task failed: ${truncate(failure ?? result?.summary ?? 'unknown reason', 200)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

