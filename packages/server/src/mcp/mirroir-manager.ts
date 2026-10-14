// Owns the Mirroir MCP server process and the MCP client session.
//
// Facts about mirroir-mcp 0.40.1 that shape this class (verified in source):
//  • It handles requests strictly one at a time and ignores
//    notifications/cancelled. A running tool cannot be interrupted except by
//    a signal; SIGTERM/SIGINT/SIGHUP release held touches/keys, then exit.
//  • permissions.json and settings.json are read once at startup from
//    <cwd>/.mirroir-mcp/, so config changes require a restart.
//  • Never declare the `sampling` capability (it would make the server read
//    our next stdin line as a sampling answer).
//  • stdout lines can be several MB (base64 PNG) — raise maxBufferSize.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerInfo, McpServerState, McpToolInfo } from '@iphone-ai/shared';

import type { ActivityLog } from '../core/activity-log.js';
import type { Logger } from '../core/logger.js';
import type { AppPaths } from '../core/paths.js';
import type { SettingsStore } from '../core/settings-store.js';
import { parseDoctorJson, type DoctorCheck } from './parsers.js';
import { isMutatingTool, workspaceFingerprint, writeMirroirWorkspace } from './workspace.js';

export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ToolCallOutcome {
  /** False when Mirroir returned isError:true. */
  ok: boolean;
  text: string;
  images: ToolImage[];
  durationMs: number;
}

export class McpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUnavailableError';
  }
}

export class McpTimeoutError extends Error {
  constructor(tool: string, timeoutMs: number) {
    super(`Mirroir did not answer "${tool}" within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'McpTimeoutError';
  }
}

const CLIENT_INFO = { name: 'iphone-ai', version: '0.1.0' };
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const STDERR_RING = 300;

export interface MirroirManagerOptions {
  paths: AppPaths;
  settings: SettingsStore;
  log: Logger;
  activity: ActivityLog;
  /** Override for tests (e.g. the mock server: process.execPath + script). */
  command?: { command: string; args: string[] } | null;
  autoRestart?: boolean;
}

export class MirroirManager extends EventEmitter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private state: McpServerState = 'stopped';
  private pid: number | null = null;
  private version: string | null = null;
  private protocolVersion: string | null = null;
  private startedAt: number | null = null;
  private restartCount = 0;
  private consecutiveCrashes = 0;
  private lastError: string | null = null;
  private tools: McpToolInfo[] = [];
  private readonly stderrLines: string[] = [];
  private intentionalClose = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private configFingerprint: string | null = null;
  private readonly log: Logger;

  constructor(private readonly opts: MirroirManagerOptions) {
    super();
    this.log = opts.log.child('mirroir');
  }

  /** The binary that will be launched (symlinks resolved, so Mirroir finds its own repo for version info). */
  resolveBinary(): string | null {
    if (this.opts.command) return this.opts.command.command;
    const configured = this.opts.settings.get().connection.mirroirBinaryPath;
    if (!existsSync(configured)) return null;
    try {
      return realpathSync(configured);
    } catch {
      return configured;
    }
  }

  info(): McpServerInfo {
    return {
      state: this.state,
      binaryPath: this.opts.command?.command ?? this.opts.settings.get().connection.mirroirBinaryPath,
      pid: this.pid,
      version: this.version,
      protocolVersion: this.protocolVersion,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      lastError: this.lastError,
      tools: this.tools,
      permissionFile: this.opts.paths.mirroirPermissionsFile,
    };
  }

  isReady(): boolean {
    return this.state === 'ready' && this.client !== null;
  }

  hasTool(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  recentStderr(): string[] {
    return [...this.stderrLines];
  }

  /** Writes workspace config and starts the server if it is not running. Idempotent. */
  async start(): Promise<void> {
    if (this.isReady()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private setState(state: McpServerState, error?: string | null): void {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.emit('state', this.info());
  }

  private async doStart(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const binary = this.resolveBinary();
    if (!binary) {
      this.setState('binary_missing', `Mirroir binary not found at ${this.opts.settings.get().connection.mirroirBinaryPath}`);
      return;
    }
    this.setState(this.restartCount > 0 ? 'restarting' : 'starting');
    this.configFingerprint = writeMirroirWorkspace(this.opts.paths, this.opts.settings.get());

    const transport = new StdioClientTransport({
      command: binary,
      args: this.opts.command?.args ?? [],
      cwd: this.opts.paths.mirroirWorkspace,
      env: getDefaultEnvironment(),
      stderr: 'pipe',
      maxBufferSize: MAX_LINE_BYTES,
    });
    const stderr = transport.stderr;
    if (stderr) {
      let partial = '';
      stderr.on('data', (chunk: Buffer) => {
        partial += chunk.toString('utf8');
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) this.pushStderr(line);
      });
    }

    // No sampling/roots/elicitation capabilities on purpose (see header comment).
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    this.intentionalClose = false;

    transport.onclose = () => this.handleClose(transport);
    transport.onerror = (err) => {
      this.log.warn('MCP transport error', { error: err.message });
    };

    try {
      await client.connect(transport, { timeout: 20000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Failed to start Mirroir MCP server', { error: message });
      this.lastError = `Could not start Mirroir: ${message}`;
      try {
        await transport.close();
      } catch {
        // ignore
      }
      this.client = null;
      this.transport = null;
      this.setState('crashed');
      this.scheduleRestart();
      return;
    }

    this.client = client;
    this.transport = transport;
    this.pid = transport.pid;
    this.startedAt = Date.now();
    const serverVersion = client.getServerVersion();
    this.version = serverVersion?.version ?? null;
    this.protocolVersion = '2025-11-25';

    try {
      const listed = await client.listTools(undefined, { timeout: 15000 });
      this.tools = listed.tools
        .map((t) => ({
          name: t.name,
          description: t.description ?? '',
          mutating: isMutatingTool(t.name),
          inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      this.tools = [];
      this.log.warn('tools/list failed', { error: err instanceof Error ? err.message : String(err) });
    }

    this.consecutiveCrashes = 0;
    this.lastError = null;
    this.setState('ready');
    this.log.info('Mirroir MCP server ready', { pid: this.pid, version: this.version, tools: this.tools.length });
    this.opts.activity.record({
      category: 'connection',
      type: 'mcp.started',
      actor: 'system',
      summary: `Mirroir MCP ${this.version ?? ''} started with ${this.tools.length} tools (${this.tools.filter((t) => t.mutating).length} input tools allowed).`,
      detail: { pid: this.pid, tools: this.tools.map((t) => t.name) },
    });
  }

  private pushStderr(line: string): void {
    if (!line.trim()) return;
    this.stderrLines.push(line);
    if (this.stderrLines.length > STDERR_RING) this.stderrLines.shift();
    if (this.opts.settings.get().advanced.mcpTrace) this.log.debug('mirroir stderr', { line });
  }

  private handleClose(transport: StdioClientTransport): void {
    if (this.transport !== transport) return;
    const wasIntentional = this.intentionalClose;
    this.client = null;
    this.transport = null;
    this.pid = null;
    this.tools = [];
    if (wasIntentional) {
      this.setState('stopped');
      return;
    }
    this.consecutiveCrashes += 1;
    const tail = this.stderrLines.slice(-3).join(' | ');
    this.setState('crashed', `Mirroir MCP server exited unexpectedly${tail ? `: ${tail}` : ''}`);
    this.log.warn('Mirroir MCP server exited unexpectedly');
    this.opts.activity.record({
      category: 'connection',
      type: 'mcp.exited',
      actor: 'system',
      severity: 'warning',
      summary: 'The Mirroir MCP server exited unexpectedly. Reconnecting…',
    });
    this.emit('exit', { intentional: false });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.opts.autoRestart === false || this.restartTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.consecutiveCrashes, 5));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartCount += 1;
      void this.start();
    }, delay);
    this.restartTimer.unref();
  }

  /** Graceful stop: closes stdin (Mirroir finishes the current tool, releases input, exits). */
  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const transport = this.transport;
    if (!transport) {
      this.setState('stopped');
      return;
    }
    this.intentionalClose = true;
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
    this.pid = null;
    this.tools = [];
    this.setState('stopped');
  }

  /**
   * Immediate termination for the emergency stop: SIGTERM makes Mirroir
   * interrupt playbacks, lift held touches/keys and exit (never SIGKILL first,
   * which would skip that cleanup).
   */
  async terminate(reason: string): Promise<void> {
    const pid = this.pid;
    const transport = this.transport;
    this.intentionalClose = true;
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    this.log.warn('Mirroir MCP server terminated', { reason });
    if (transport) {
      try {
        await transport.close();
      } catch {
        // ignore
      }
    }
    this.client = null;
    this.transport = null;
    this.pid = null;
    this.tools = [];
    this.setState('stopped', reason);
  }

  async restart(reason: string): Promise<void> {
    this.log.info('Restarting Mirroir MCP server', { reason });
    await this.stop();
    this.restartCount += 1;
    await this.start();
  }

  /** True when the workspace config on disk would differ from the one the running server loaded. */
  configChanged(): boolean {
    return workspaceFingerprint(this.opts.settings.get()) !== this.configFingerprint;
  }

  /**
   * Calls a Mirroir tool. Callers must serialise calls (DeviceController does).
   * A timeout means the single-threaded server is wedged: it is terminated so
   * that held input is released, and restarted.
   */
  async call(name: string, args: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<ToolCallOutcome> {
    const client = this.client;
    if (!client || this.state !== 'ready') {
      throw new McpUnavailableError(
        this.state === 'binary_missing'
          ? this.lastError ?? 'Mirroir binary not found'
          : `Mirroir MCP server is ${this.state.replace('_', ' ')}`,
      );
    }
    const timeoutMs = options.timeoutMs ?? this.opts.settings.get().connection.requestTimeoutMs;
    const started = Date.now();
    try {
      const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as {
        content?: { type: string; text?: string; data?: string; mimeType?: string }[];
        isError?: boolean;
      };
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n');
      const images = content
        .filter((c) => c.type === 'image' && typeof c.data === 'string')
        .map((c) => ({ data: c.data as string, mimeType: c.mimeType ?? 'image/png' }));
      return { ok: result.isError !== true, text, images, durationMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/timed out|timeout/i.test(message)) {
        this.log.error('Mirroir tool call timed out; restarting server', { tool: name, timeoutMs });
        await this.terminate(`"${name}" timed out`);
        this.restartCount += 1;
        void this.start();
        throw new McpTimeoutError(name, timeoutMs);
      }
      if (!this.client) throw new McpUnavailableError(`Mirroir connection lost during "${name}"`);
      throw err;
    }
  }

  /** Runs `mirroir doctor --json` (read-only preflight; JSON is written to stderr). */
  async runDoctor(): Promise<DoctorCheck[] | null> {
    if (this.opts.command) return null;
    const binary = this.resolveBinary();
    if (!binary) return null;
    return new Promise((resolve) => {
      const child = spawn(binary, ['doctor', '--json', '--no-color'], {
        cwd: this.opts.paths.mirroirWorkspace,
        env: getDefaultEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(parseDoctorJson(stderr)?.checks ?? null);
      });
    });
  }
}
