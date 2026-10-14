// A task cancelled before a loop provider (Claude Agent SDK) starts must not
// spawn a Claude Code session, and must end as cancelled.

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDefaultSettings } from '@iphone-ai/shared';

import { runAgent } from '../../src/ai/agent/runner.js';
import { TaskAbortedError, type AgentToolkit } from '../../src/ai/agent/toolkit.js';
import { ClaudeAgentSdkProvider } from '../../src/ai/providers/claude-agent-sdk.js';
import type { LoopProvider } from '../../src/ai/types.js';
import { makeTempDir } from '../helpers/context.js';

const config = createDefaultSettings().ai.providers.find((p) => p.id === 'claude-code')!;

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new TaskAbortedError('Cancelled by you.', 'cancelled'));
  return controller.signal;
}

describe('cancel before the loop starts', () => {
  it('runAgent rejects with the cancel reason and never calls runLoop', async () => {
    let called = false;
    const provider: LoopProvider = {
      kind: 'loop',
      config,
      async runLoop() {
        called = true;
        return { finalText: '', stop: 'end' };
      },
      async complete() {
        return '';
      },
      async test() {
        return { ok: true, latencyMs: 0, message: '', model: null, supportsTools: true, supportsVision: true };
      },
    };
    const toolkit = { executableTools: () => [], result: null } as unknown as AgentToolkit;
    const run = runAgent({
      provider,
      toolkit,
      system: 's',
      prompt: [{ type: 'text', text: 'p' }],
      signal: aborted(),
      maxTurns: 4,
      callbacks: { onText: () => undefined, onReasoning: () => undefined, onTurnEnd: () => undefined },
    });
    await expect(run).rejects.toMatchObject({ name: 'TaskAbortedError', reason: 'cancelled' });
    expect(called).toBe(false);
  });

  it('ClaudeAgentSdkProvider does not spawn Claude Code for an already-cancelled task', async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, 'spawned');
    const binary = path.join(dir, 'claude');
    writeFileSync(binary, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    const provider = new ClaudeAgentSdkProvider(config, { binaryPath: binary, apiKey: null, workDir: path.join(dir, 'work') });
    await expect(
      provider.runLoop({ system: 's', prompt: 'p', tools: [], signal: aborted(), maxTurns: 2, isFinished: () => false }),
    ).rejects.toBeInstanceOf(TaskAbortedError);
    await expect(provider.complete({ system: 's', content: [{ type: 'text', text: 'p' }], signal: aborted() })).rejects.toBeInstanceOf(
      TaskAbortedError,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker)).toBe(false);
  });
});
