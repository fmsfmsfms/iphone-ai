// Shared harness for AI task tests: a SCRIPTED model (no network), the real
// AgentService / toolkit / policy / approvals / DeviceController, and the MOCK
// Mirroir server (no phone). These verify control flow and safety behaviour;
// they are not real-device results.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentTask, ControlMode, ProviderConfig, ServerEvent } from '@iphone-ai/shared';

import { AgentService } from '../../src/ai/agent-service.js';
import { ScreenshotStore } from '../../src/ai/screenshots.js';
import type { AiProvider, ToolCall, TurnMessage, TurnProvider, TurnRequest, TurnResult } from '../../src/ai/types.js';
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

export type Script = (ctx: { turn: number; lastResultText: string; messages: TurnMessage[] }) => Partial<TurnResult> | Promise<Partial<TurnResult>>;

export class ScriptedProvider implements TurnProvider {
  readonly kind = 'turn' as const;
  turns = 0;
  readonly seenTools: string[][] = [];
  /** The history sent with every turn (shallow copies). */
  readonly requests: TurnMessage[][] = [];
  constructor(
    readonly config: ProviderConfig,
    private readonly script: Script,
  ) {}
  async runTurn(request: TurnRequest): Promise<TurnResult> {
    if (request.signal.aborted) throw request.signal.reason;
    this.seenTools.push(request.tools.map((t) => t.name));
    this.requests.push([...request.messages]);
    const out = await this.script({ turn: this.turns++, lastResultText: lastResultText(request.messages), messages: request.messages });
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

export function lastResultText(messages: readonly TurnMessage[]): string {
  const last = messages[messages.length - 1];
  return last?.role === 'tool_results'
    ? last.results.map((r) => r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')).join('\n')
    : last?.role === 'user'
      ? last.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')
      : '';
}

export function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call_${Math.random().toString(36).slice(2, 10)}`, name, args };
}

/** Finds the element id for a label in an observation text ("[e7] "Wi-Fi" at (x, y)"). */
export function idOf(text: string, label: string): string {
  const match = new RegExp(`\\[(e\\d+)\\] "${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(text);
  if (!match) throw new Error(`Element "${label}" not found in:\n${text}`);
  return match[1]!;
}

export interface MockPhone {
  stack: string[];
  safariUrl: string | null;
  fields: Record<string, string>;
  conversations: Record<string, { from: string; text: string }[]>;
}

export interface Harness {
  paths: AppPaths;
  db: Database;
  hub: EventHub;
  settings: SettingsStore;
  activity: ActivityLog;
  mirroir: MirroirManager;
  device: DeviceController;
  approvals: ApprovalBroker;
  agents: AgentService;
  screenshots: ScreenshotStore;
  events: ServerEvent[];
  provider: ScriptedProvider | null;
  setScript(script: Script): void;
  failProvider(error: Error): void;
  /** Replaces the scripted turn provider (e.g. with a loop provider). */
  setProvider(build: ((config: ProviderConfig) => AiProvider) | null): void;
  /** Delay before buildProvider resolves (simulates the Keychain read). */
  setBuildDelay(ms: number): void;
  writeState(state: Record<string, unknown>): void;
  calls(): { name?: string; args?: Record<string, unknown>; signal?: string }[];
  /** The mock phone's persisted state. */
  phone(): MockPhone;
  close(): Promise<void>;
}

export async function createHarness(mode: ControlMode): Promise<Harness> {
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
  let custom: ((config: ProviderConfig) => AiProvider) | null = null;
  let buildDelayMs = 0;
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
    screenshots,
    events,
    provider: null,
    setScript: (s) => {
      script = s;
    },
    failProvider: (e) => {
      failure = e;
    },
    setProvider: (build) => {
      custom = build;
    },
    setBuildDelay: (ms) => {
      buildDelayMs = ms;
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
    phone: () => {
      // The mock writes this file on its first state change; before that the phone is at Home.
      const file = path.join(paths.mirroirWorkspace, 'mock-phone.json');
      if (!existsSync(file)) return { stack: ['home'], safariUrl: null, fields: {}, conversations: {} };
      return JSON.parse(readFileSync(file, 'utf8')) as MockPhone;
    },
    close: async () => {
      approvals.cancelAll('test cleanup');
      device.stopMonitoring();
      await mirroir.stop();
      db.close();
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
      if (buildDelayMs > 0) await new Promise((r) => setTimeout(r, buildDelayMs));
      if (failure) throw failure;
      if (custom) return custom(config);
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

export async function waitForTask(h: Harness, taskId: string, timeoutMs = 25000): Promise<AgentTask> {
  const started = Date.now();
  for (;;) {
    const row = h.agents.getTask(taskId);
    if (row && ['completed', 'failed', 'cancelled', 'stopped'].includes(row.task.status) && h.agents.activeTask() === null) return row.task;
    if (Date.now() - started > timeoutMs) throw new Error(`Task ${taskId} did not finish (status ${row?.task.status})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}
