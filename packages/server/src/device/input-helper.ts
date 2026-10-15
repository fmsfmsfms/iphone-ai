// iPhone AI's own swipe: the `iphone-ai-input` helper (Swift,
// src-tauri/input/main.swift) posts one eased scroll gesture ("glide") to the
// iPhone Mirroring window — fast, then slowing to a stop before the lift, so
// iOS snaps a paging feed to the next item at once (≈0.35 s instead of
// Mirroir's ≈2.9 s flick + settle; see shared swipe.ts and docs/TESTING.md).
//
// The DeviceController uses it for `swipe` actions after its own checks, and
// falls back to Mirroir's `swipe` when the helper cannot run a gesture at all
// (not installed, no Accessibility permission, no window, could not activate
// iPhone Mirroring). A helper that stops part-way is reported as a failure,
// never retried through Mirroir (that could swipe twice). STOP kills it.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../core/logger.js';

export const INPUT_HELPER_NAME = 'iphone-ai-input';
/** Gesture length of every glide. */
export const GLIDE_DURATION_MS = 250;
/** Whole helper run (activation, gesture, pointer restore); a hung helper is killed. */
const GLIDE_TIMEOUT_MS = 6000;
/** After a permission problem, Mirroir handles swipes for this long before the helper is tried again. */
const NOT_TRUSTED_BACKOFF_MS = 60_000;

export interface InputHelperCommand {
  command: string;
  args: string[];
}

export type GlideOutcome =
  | { ok: true; ms: number; activated: boolean }
  /** `fallback`: nothing was posted, so Mirroir's swipe may run instead. */
  | { ok: false; fallback: boolean; code: string; message: string };

/**
 * Finds the input helper: env IPHONE_AI_INPUT_BIN, else next to the running
 * Node binary (the app bundle's Contents/MacOS), else — in development — the
 * build at <repo>/src-tauri/binaries/iphone-ai-input-<arch>-apple-darwin.
 * Never in mock mode: the helper would swipe the real phone.
 */
export function resolveInputHelper(
  options: { env?: NodeJS.ProcessEnv; mock?: boolean; platform?: NodeJS.Platform; arch?: string; execPath?: string; repoRoot?: string | null } = {},
): { helper: InputHelperCommand | null; reason: string | null } {
  const env = options.env ?? process.env;
  if (options.mock) return { helper: null, reason: 'mock Mirroir mode (there is no real iPhone to swipe)' };
  const explicit = env.IPHONE_AI_INPUT_BIN?.trim();
  if (explicit) {
    if (existsSync(explicit)) return { helper: { command: explicit, args: [] }, reason: null };
    return { helper: null, reason: `the input helper set in IPHONE_AI_INPUT_BIN was not found (${explicit})` };
  }
  if ((options.platform ?? process.platform) !== 'darwin') return { helper: null, reason: 'the input helper needs macOS' };
  const sibling = path.join(path.dirname(options.execPath ?? process.execPath), INPUT_HELPER_NAME);
  if (existsSync(sibling)) return { helper: { command: sibling, args: [] }, reason: null };
  const root = options.repoRoot === undefined ? defaultRepoRoot() : options.repoRoot;
  if (root) {
    const arch = (options.arch ?? process.arch) === 'arm64' ? 'aarch64' : 'x86_64';
    const candidate = path.join(root, 'src-tauri', 'binaries', `${INPUT_HELPER_NAME}-${arch}-apple-darwin`);
    if (existsSync(candidate)) return { helper: { command: candidate, args: [] }, reason: null };
  }
  return { helper: null, reason: 'the iphone-ai-input helper is not installed' };
}

function defaultRepoRoot(): string | null {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  } catch {
    return null;
  }
}

/** Codes the helper reports before posting anything (Mirroir may take over). */
const BEFORE_POSTING = new Set(['not_trusted', 'no_window', 'activation_failed', 'bad_args']);

export class InputHelper {
  private child: ChildProcess | null = null;
  private killedByStop = false;
  private notTrustedUntil = 0;

  constructor(
    private readonly helper: InputHelperCommand | null,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a glide may be attempted now. */
  get available(): boolean {
    return this.helper !== null && this.now() >= this.notTrustedUntil;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Ends a running glide (the helper lifts and exits); used by the emergency stop. */
  kill(): void {
    if (!this.child) return;
    this.killedByStop = true;
    this.child.kill('SIGTERM');
  }

  /** Glides the finger by (dx, dy) window points across the middle of the iPhone Mirroring window. */
  glide(dx: number, dy: number): Promise<GlideOutcome> {
    const helper = this.helper;
    if (!helper) return Promise.resolve({ ok: false, fallback: true, code: 'unavailable', message: 'the input helper is not installed' });
    if (this.child) return Promise.resolve({ ok: false, fallback: true, code: 'busy', message: 'another glide is running' });
    const args = [...helper.args, 'glide', '--dx', String(round1(dx)), '--dy', String(round1(dy)), '--duration-ms', String(GLIDE_DURATION_MS)];
    return new Promise<GlideOutcome>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let child: ChildProcess;
      let timer: NodeJS.Timeout | undefined;
      this.killedByStop = false;
      const finish = (outcome: GlideOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.child = null;
        if (!outcome.ok && outcome.code === 'not_trusted') this.notTrustedUntil = this.now() + NOT_TRUSTED_BACKOFF_MS;
        if (!outcome.ok) this.log.warn('Glide swipe did not run', { code: outcome.code, message: outcome.message, fallback: outcome.fallback });
        resolve(outcome);
      };
      try {
        child = spawn(helper.command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        finish({ ok: false, fallback: true, code: 'spawn_failed', message: err instanceof Error ? err.message : String(err) });
        return;
      }
      this.child = child;
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, fallback: false, code: 'timeout', message: `the input helper did not finish within ${GLIDE_TIMEOUT_MS / 1000} s` });
      }, GLIDE_TIMEOUT_MS);
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', (err) => {
        // ENOENT / EACCES: the process never ran, so nothing was posted.
        finish({ ok: false, fallback: true, code: 'spawn_failed', message: err.message });
      });
      child.on('close', (code) => {
        const result = parseResult(stdout);
        if (this.killedByStop) {
          finish({ ok: false, fallback: false, code: 'stopped', message: 'the swipe was stopped by the emergency stop' });
        } else if (code === 0 && result?.ok === true) {
          finish({ ok: true, ms: typeof result.ms === 'number' ? result.ms : 0, activated: result.activated === true });
        } else if (result && result.ok === false && typeof result.error === 'string') {
          finish({ ok: false, fallback: BEFORE_POSTING.has(result.error), code: result.error, message: String(result.message ?? result.error) });
        } else {
          const detail = (stderr.trim() || stdout.trim()).slice(0, 300);
          finish({ ok: false, fallback: false, code: 'crashed', message: `the input helper exited with ${code ?? 'a signal'}${detail ? `: ${detail}` : ''}` });
        }
      });
    });
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseResult(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split('\n').pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
