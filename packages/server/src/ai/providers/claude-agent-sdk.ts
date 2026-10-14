// Claude through the Claude Agent SDK (the Claude Code engine), using the
// user's OWN local Claude Code authentication — an opt-in mode for personal
// use. Anthropic's terms do not allow third-party products to offer claude.ai
// login; the default Claude path in iPhone AI is the Anthropic API key.
//
// Isolation (per the SDK docs): built-in tools disabled (tools: []), only the
// in-process "iphone" MCP tools exist, no user/project settings or MCP config
// are loaded, the CLI gets a minimal explicit environment, nothing persists.
// Every tool still goes through iPhone AI's policy, approvals and lease checks
// inside ExecutableTool.execute — canUseTool only restricts the tool set.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProviderConfig, ProviderTestResult } from '@iphone-ai/shared';
import type { ZodRawShape } from 'zod';

import { ProviderError, type LoopProvider, type LoopRequest, type ModelContent } from '../types.js';

const SERVER_NAME = 'iphone';
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

export interface ClaudeCodeAuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider?: string;
  email?: string | null;
  subscriptionType?: string | null;
}

/** Locates the Claude Code binary shipped with the Agent SDK (bundled into the app, or from node_modules in development). */
export function resolveClaudeCodeBinary(): string | null {
  const fromEnv = process.env.IPHONE_AI_CLAUDE_CODE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const sdkRequire = createRequire(sdkEntry);
    const bin = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** Minimal environment for the Claude Code CLI (Options.env replaces the whole environment). */
function cliEnv(apiKey: string | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? '',
    USER: process.env.USER ?? '',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'iphone-ai/0.1.0',
    DISABLE_AUTOUPDATER: '1',
  };
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

export async function claudeCodeAuthStatus(binary: string, apiKey: string | null): Promise<ClaudeCodeAuthStatus> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['auth', 'status', '--json'], { env: cliEnv(apiKey), timeout: 20000 }, (err, stdout) => {
      if (err && !stdout) {
        reject(err);
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ClaudeCodeAuthStatus);
      } catch {
        reject(new Error(`Unexpected output from claude auth status: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

export class ClaudeAgentSdkProvider implements LoopProvider {
  readonly kind = 'loop' as const;

  constructor(
    readonly config: ProviderConfig,
    private readonly options: { binaryPath: string | null; apiKey: string | null; workDir: string; onStderr?: (line: string) => void },
  ) {}

  private binary(): string {
    if (!this.options.binaryPath) {
      throw new ProviderError(
        'The Claude Code engine is not available in this build. Use the "Claude (Anthropic API)" provider instead.',
        false,
        'config',
      );
    }
    return this.options.binaryPath;
  }

  private baseOptions(abortController: AbortController) {
    mkdirSync(this.options.workDir, { recursive: true, mode: 0o700 });
    return {
      model: this.config.model || undefined,
      tools: [] as string[],
      permissionMode: 'default' as const,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      includePartialMessages: true,
      abortController,
      cwd: this.options.workDir,
      env: cliEnv(this.options.apiKey),
      pathToClaudeCodeExecutable: this.binary(),
      ...(this.config.effort ? { effort: this.config.effort } : {}),
      thinking: { type: 'adaptive' as const, display: 'summarized' as const },
      stderr: (data: string) => this.options.onStderr?.(data),
    };
  }

  async runLoop(request: LoopRequest): Promise<{ finalText: string; stop: 'finished' | 'max_turns' | 'end' | 'error'; error?: string }> {
    // An 'abort' listener never fires for a signal that is already aborted: check first, spawn nothing.
    throwIfAborted(request.signal);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(request.signal.reason);
    request.signal.addEventListener('abort', onAbort, { once: true });

    const server = createSdkMcpServer({
      name: SERVER_NAME,
      version: '1.0.0',
      alwaysLoad: true,
      tools: request.tools.map((t) =>
        tool(t.name, t.description, t.zodShape as ZodRawShape, async (args: Record<string, unknown>) => {
          const result = await t.execute(args);
          return {
            content: result.content.map((c) =>
              c.type === 'text'
                ? { type: 'text' as const, text: c.text }
                : { type: 'image' as const, data: c.data, mimeType: c.mimeType },
            ),
            isError: result.isError,
          };
        }),
      ),
    });

    const canUseTool: CanUseTool = async (toolName, input) =>
      toolName.startsWith(TOOL_PREFIX)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Only the iPhone tools are available in iPhone AI.' };

    let finalText = '';
    let stop: 'finished' | 'max_turns' | 'end' | 'error' = 'end';
    let error: string | undefined;
    try {
      const q = query({
        prompt: request.prompt,
        options: {
          ...this.baseOptions(abortController),
          systemPrompt: request.system,
          mcpServers: { [SERVER_NAME]: server },
          canUseTool,
          maxTurns: request.maxTurns,
        },
      });
      for await (const message of q as AsyncIterable<SDKMessage>) {
        this.handleMessage(message, request);
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            finalText = message.result;
          } else {
            stop = message.subtype === 'error_max_turns' ? 'max_turns' : 'error';
            error = 'errors' in message && Array.isArray(message.errors) ? message.errors.join('; ') : message.subtype;
          }
        }
        if (message.type === 'assistant' && 'error' in message && message.error) {
          stop = 'error';
          error = describeAssistantError(String(message.error));
        }
      }
    } catch (err) {
      if (request.signal.aborted) throw err;
      throw new ProviderError(err instanceof Error ? err.message : String(err), false, 'unknown');
    } finally {
      request.signal.removeEventListener('abort', onAbort);
    }
    if (request.isFinished()) stop = 'finished';
    return { finalText, stop, ...(error ? { error } : {}) };
  }

  private handleMessage(message: SDKMessage, request: Pick<LoopRequest, 'onText' | 'onReasoning'>): void {
    if (message.type !== 'stream_event' || message.parent_tool_use_id !== null) return;
    const event = message.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
    if (event.type !== 'content_block_delta' || !event.delta) return;
    if (event.delta.type === 'text_delta' && event.delta.text) request.onText?.(event.delta.text);
    if (event.delta.type === 'thinking_delta' && event.delta.thinking) request.onReasoning?.(event.delta.thinking);
  }

  async complete(request: { system: string; content: ModelContent[]; signal: AbortSignal; maxTokens?: number }): Promise<string> {
    throwIfAborted(request.signal);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(request.signal.reason);
    request.signal.addEventListener('abort', onAbort, { once: true });
    const user: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: request.content.map((c) =>
          c.type === 'text'
            ? { type: 'text' as const, text: c.text }
            : { type: 'image' as const, source: { type: 'base64' as const, media_type: c.mimeType as 'image/png', data: c.data } },
        ),
      },
    } as SDKUserMessage;
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield user;
    }
    let text = '';
    try {
      const q = query({ prompt: prompt(), options: { ...this.baseOptions(abortController), systemPrompt: request.system, maxTurns: 1 } });
      for await (const message of q as AsyncIterable<SDKMessage>) {
        if (message.type === 'result') {
          if (message.subtype === 'success') text = message.result;
          else throw new ProviderError(`Claude Code returned ${message.subtype}`, false, 'unknown');
          break;
        }
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
    }
    return text;
  }

  async test(): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const status = await claudeCodeAuthStatus(this.binary(), this.options.apiKey);
      return {
        ok: status.loggedIn,
        latencyMs: Date.now() - started,
        message: status.loggedIn
          ? `Claude Code is signed in (${status.authMethod}${status.subscriptionType ? `, ${status.subscriptionType}` : ''}). Note: this checks that credentials exist, not that they are valid.`
          : 'Claude Code is not signed in on this Mac. Sign in with the Claude Code CLI, or use the Anthropic API provider.',
        model: this.config.model || null,
        supportsTools: true,
        supportsVision: true,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: err instanceof Error ? err.message : String(err),
        model: null,
        supportsTools: null,
        supportsVision: null,
      };
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
}

function describeAssistantError(code: string): string {
  switch (code) {
    case 'authentication_failed':
      return 'Claude Code authentication failed. Sign in again with the Claude Code CLI or use an API key.';
    case 'billing_error':
      return 'Claude Code reported a billing problem with this account.';
    case 'rate_limit':
      return 'Claude Code usage limit reached. Try again later.';
    case 'overloaded':
      return 'Claude is overloaded. Try again shortly.';
    default:
      return `Claude Code error: ${code}`;
  }
}

export function claudeCodeWorkDir(dataDir: string): string {
  return path.join(dataDir, 'claude-code-session');
}
