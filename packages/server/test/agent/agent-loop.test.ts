// End-to-end tests of the AI task loop with a SCRIPTED model (no network),
// the real AgentService / toolkit / policy / approvals / DeviceController, and
// the MOCK Mirroir server (no phone). These verify control flow and safety
// behaviour; they are not real-device results.

import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentTask, ProviderConfig, ServerEvent } from '@iphone-ai/shared';

import { AgentService } from '../../src/ai/agent-service.js';
import { ScreenshotStore } from '../../src/ai/screenshots.js';
import type { ToolCall, TurnMessage, TurnProvider, TurnRequest, TurnResult } from '../../src/ai/types.js';
import { ProviderError } from '../../src/ai/types.js';
import { ActivityLog } from '../../src/core/activity-log.js';
import { EventHub } from '../../src/core/events.js';
import { silentLogger } from '../../src/core/logger.js';
import { ensureAppDirectories, resolveAppPaths, type AppPaths } from '../../src/core/paths.js';
import { SettingsStore } from '../../src/core/settings-store.js';
import { Database } from '../../src/db/database.js';
import { DeviceController } from '../../src/device/device-controller.js';
import { MirroirManager } from '../../src/mcp/mirroir-manager.js';
import { ApprovalBroker } from '../../src/policy/approvals.js';
import { MemorySecretStore } from '../../src/security/secrets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(here, '../mock-mirroir/server.mjs');

type Script = (ctx: { turn: number; lastResultText: string; messages: TurnMessage[] }) => Partial<TurnResult> | Promise<Partial<TurnResult>>;

class ScriptedProvider implements TurnProvider {
  readonly kind = 'turn' as const;
  turns = 0;
  readonly seenTools: string[][] = [];
  constructor(
    readonly config: ProviderConfig,
    private readonly script: Script,
  ) {}
  async runTurn(request: TurnRequest): Promise<TurnResult> {
    if (request.signal.aborted) throw request.signal.reason;
    this.seenTools.push(request.tools.map((t) => t.name));
    const last = request.messages[request.messages.length - 1];
    const lastResultText =
      last?.role === 'tool_results'
        ? last.results.map((r) => r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')).join('\n')
        : last?.role === 'user'
          ? last.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')
          : '';
    const out = await this.script({ turn: this.turns++, lastResultText, messages: request.messages });
    const toolCalls = out.toolCalls ?? [];
    return { text: out.text ?? '', toolCalls, stop: out.stop ?? (toolCalls.length ? 'tool_use' : 'end') };
  }
  async complete(): Promise<string> {
    return '';
  }
  async test() {
    return { ok: true, latencyMs: 0, message: 'scripted', model: 'scripted', supportsTools: true, supportsVision: false };
  }
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call_${Math.random().toString(36).slice(2, 10)}`, name, args };
}

/** Finds the element id for a label in an observation text ("[e7] "Wi-Fi" at (x, y)"). */
function idOf(text: string, label: string): string {
  const match = new RegExp(`\\[(e\\d+)\\] "${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(text);
  if (!match) throw new Error(`Element "${label}" not found in:\n${text}`);
  return match[1]!;
}

interface Harness {
  paths: AppPaths;
  db: Database;
  hub: EventHub;
  settings: SettingsStore;
  activity: ActivityLog;
  mirroir: MirroirManager;
  device: DeviceController;
  approvals: ApprovalBroker;
  agents: AgentService;
  events: ServerEvent[];
  provider: ScriptedProvider | null;
  setScript(script: Script): void;
  failProvider(error: Error): void;
  writeState(state: Record<string, unknown>): void;
  calls(): { name?: string; args?: Record<string, unknown>; signal?: string }[];
}

async function createHarness(mode: 'observe' | 'assisted' | 'supervised'): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'iphone-ai-agent-'));
  const paths = resolveAppPaths({ dataDir: dir, webDistDir: null });
  ensureAppDirectories(paths);
  const db = new Database(':memory:');
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const settings = new SettingsStore(db);
  settings.update({ permissions: { controlMode: mode }, ai: { settleDelayMs: 100 } });
  const activity = new ActivityLog(db, hub, 'test');
  const mirroir = new MirroirManager({ paths, settings, log: silentLogger, activity, command: { command: process.execPath, args: [MOCK] } });
  const device = new DeviceController(mirroir, settings, hub, activity, silentLogger, {
    screenRecording: 'granted',
    accessibility: 'granted',
    source: 'mock (assumed)',
  });
  const approvals = new ApprovalBroker(db, hub, activity);
  const screenshots = new ScreenshotStore(db, paths, settings);
  let script: Script = () => ({ toolCalls: [call('finish_task', { status: 'failed', summary: 'no script' })] });
  let failure: Error | null = null;
  const harness: Harness = {
    paths,
    db,
    hub,
    settings,
    activity,
    mirroir,
    device,
    approvals,
    agents: null as unknown as AgentService,
    events,
    provider: null,
    setScript: (s) => {
      script = s;
    },
    failProvider: (e) => {
      failure = e;
    },
    writeState: (state) => writeFileSync(path.join(paths.mirroirWorkspace, 'mock-state.json'), JSON.stringify(state)),
    calls: () => {
      const file = path.join(paths.mirroirWorkspace, 'mock-calls.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { name?: string; args?: Record<string, unknown>; signal?: string });
    },
  };
  harness.agents = new AgentService({
    db,
    settings,
    secrets: new MemorySecretStore(),
    hub,
    activity,
    device,
    approvals,
    screenshots,
    paths,
    log: silentLogger,
    buildProvider: async (config) => {
      if (failure) throw failure;
      harness.provider = new ScriptedProvider(config, (ctx) => script(ctx));
      return harness.provider;
    },
  });
  await mirroir.start();
  device.start();
  await device.refreshPermissions();
  await device.refreshStatus();
  return harness;
}

async function waitForTask(h: Harness, taskId: string, timeoutMs = 25000): Promise<AgentTask> {
  const started = Date.now();
  for (;;) {
    const row = h.agents.getTask(taskId);
    if (row && ['completed', 'failed', 'cancelled', 'stopped'].includes(row.task.status) && h.agents.activeTask() === null) return row.task;
    if (Date.now() - started > timeoutMs) throw new Error(`Task ${taskId} did not finish (status ${row?.task.status})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('AI task loop (scripted model × mock Mirroir)', () => {
  let h: Harness;

  afterEach(async () => {
    h.device.stopMonitoring();
    await h.mirroir.stop();
    h.db.close();
  });

  describe('supervised mode', () => {
    beforeEach(async () => {
      h = await createHarness('supervised');
    });

    it('opens Settings, navigates to Wi-Fi and verifies the result on screen', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn === 0) return { text: 'Opening Settings.', toolCalls: [call('open_app', { name: 'Settings', reason: 'Wi-Fi lives in Settings' })] };
        if (turn === 1) return { toolCalls: [call('tap', { element_id: idOf(lastResultText, 'Wi-Fi'), reason: 'open Wi-Fi' })] };
        return { toolCalls: [call('finish_task', { status: 'success', summary: 'Wi-Fi settings are open.', evidence: ['Wi-Fi'] })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Navigate to Wi-Fi settings.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('completed');
      expect(done.outcome).toMatchObject({ success: true, verified: true });
      const names = h.calls().map((c) => c.name);
      expect(names).toContain('launch_app');
      expect(names).toContain('tap');
      expect(names.filter((n) => n === 'describe_screen').length).toBeGreaterThanOrEqual(3);
      const steps = h.agents.getTask(task.id)!.steps;
      expect(steps.some((s) => s.type === 'tool_call' && s.tool?.name === 'launch_app' && s.tool.ok)).toBe(true);
      expect(steps.some((s) => s.type === 'verify')).toBe(true);
      const messages = h.agents.getMessages(conversation.id);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('marks success as NOT verified when the evidence is not on the final screen', async () => {
      h.setScript(({ turn }) =>
        turn === 0
          ? { toolCalls: [call('finish_task', { status: 'success', summary: 'Done', evidence: ['Battery Percentage'] })] }
          : { text: 'ok' },
      );
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Check my battery percentage.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.outcome).toMatchObject({ success: true, verified: false });
    });

    it('blocks opening a blocked app and never sends launch_app to Mirroir', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn === 0) return { toolCalls: [call('open_app', { name: 'Wallet', reason: 'test' })] };
        expect(lastResultText).toContain('BLOCKED');
        return { toolCalls: [call('finish_task', { status: 'needs_user', summary: 'Wallet is blocked.' })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Open Wallet.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('failed');
      expect(h.calls().some((c) => c.name === 'launch_app')).toBe(false);
      expect(h.activity.query({ categories: ['policy'] }).some((e) => e.type === 'policy.denied')).toBe(true);
    });

    it('refuses the same action on an unchanged screen after two attempts', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn < 4) return { toolCalls: [call('tap', { x: 30, y: 870, reason: 'tap empty area' })] };
        expect(lastResultText).toContain('Loop detected');
        return { toolCalls: [call('finish_task', { status: 'failed', summary: 'Stuck.' })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Tap the corner.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('failed');
      expect(h.calls().filter((c) => c.name === 'tap').length).toBe(2);
    });

    it('reports provider failures as a failed task with a readable error', async () => {
      h.failProvider(new ProviderError('Cannot reach the Anthropic API. Check your network connection.', true, 'unavailable'));
      const conversation = h.agents.createConversation();
      await expect(h.agents.startTask(conversation.id, { text: 'Open Settings.' }, 'user')).rejects.toThrow(/Cannot reach/);
      expect(h.agents.activeTask()).toBeNull();
    });

    it('stops the task and terminates Mirroir when STOP is pressed during an action', async () => {
      h.writeState({ slowMs: { launch_app: 8000 } });
      h.setScript(({ turn }) =>
        turn === 0
          ? { toolCalls: [call('open_app', { name: 'Settings', reason: 'slow launch' })] }
          : { toolCalls: [call('finish_task', { status: 'failed', summary: 'should not get here' })] },
      );
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Open Settings.' }, 'user');
      await waitFor(() => h.calls().some((c) => c.name === 'launch_app'));
      await h.device.emergencyStop('test', 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('stopped');
      expect(h.calls().some((c) => c.signal === 'SIGTERM')).toBe(true);
      expect(h.device.isStopLatched).toBe(true);
      h.device.rearm('user');
      await waitFor(() => h.mirroir.isReady(), 20000);
    });

    it('fails gracefully when iPhone Mirroring disconnects during the task', async () => {
      h.setScript(({ turn }) => {
        if (turn === 0) {
          h.writeState({ mirroring: 'not_running' });
          return { toolCalls: [call('go_home', { reason: 'start from home' })] };
        }
        return { toolCalls: [call('finish_task', { status: 'failed', summary: 'Mirroring disconnected.' })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Go home.' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('failed');
      const steps = h.agents.getTask(task.id)!.steps;
      expect(steps.some((s) => /not connected|not running/i.test(`${s.detail ?? ''} ${s.tool?.result ?? ''}`))).toBe(true);
    });
  });

  describe('assisted mode', () => {
    beforeEach(async () => {
      h = await createHarness('assisted');
    });

    it('waits for approval and executes only after the user approves', async () => {
      h.setScript(({ turn }) =>
        turn === 0
          ? { toolCalls: [call('open_app', { name: 'Settings', reason: 'open settings' })] }
          : { toolCalls: [call('finish_task', { status: 'success', summary: 'Settings open', evidence: ['Settings'] })] },
      );
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Open Settings on my iPhone.' }, 'user');
      await waitFor(() => h.approvals.listPending().length === 1);
      expect(h.calls().some((c) => c.name === 'launch_app')).toBe(false);
      const pending = h.approvals.listPending()[0]!;
      h.approvals.decide(pending.id, 'approved', 'user');
      const done = await waitForTask(h, task.id);
      expect(done.status).toBe('completed');
      expect(h.calls().some((c) => c.name === 'launch_app')).toBe(true);
    });

    it('does not execute a rejected action', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn === 0) return { toolCalls: [call('go_home', { reason: 'home' })] };
        expect(lastResultText).toContain('REJECTED');
        return { toolCalls: [call('finish_task', { status: 'needs_user', summary: 'You rejected going home.' })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'Go home.' }, 'user');
      await waitFor(() => h.approvals.listPending().length === 1);
      h.approvals.decide(h.approvals.listPending()[0]!.id, 'rejected', 'user', 'not now');
      await waitForTask(h, task.id);
      expect(h.calls().some((c) => c.name === 'press_home')).toBe(false);
    });
  });

  describe('observe-only mode', () => {
    beforeEach(async () => {
      h = await createHarness('observe');
    });

    it('offers only observation tools and never sends input', async () => {
      h.setScript(({ turn, lastResultText }) => {
        if (turn === 0) return { toolCalls: [call('tap', { x: 10, y: 10, reason: 'try' })] };
        expect(lastResultText).toMatch(/Unknown or unavailable tool/);
        return { toolCalls: [call('finish_task', { status: 'success', summary: 'The Home Screen is showing.', evidence: ['Settings'] })] };
      });
      const conversation = h.agents.createConversation();
      const { task } = await h.agents.startTask(conversation.id, { text: 'What is on my screen?' }, 'user');
      const done = await waitForTask(h, task.id);
      expect(h.provider!.seenTools[0]).toEqual(['observe_screen', 'wait', 'finish_task']);
      expect(done.status).toBe('completed');
      const inputTools = ['tap', 'swipe', 'type_text', 'launch_app', 'press_home', 'press_key'];
      expect(h.calls().some((c) => inputTools.includes(c.name ?? ''))).toBe(false);
      expect(h.device.currentLease).toBeNull();
    });
  });
});

// Silence "unused" lint for helpers kept for future scenarios.
void appendFileSync;
