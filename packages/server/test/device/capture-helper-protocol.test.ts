// The real Swift capture helper (src-tauri/capture/main.swift) against the
// backend's wire-protocol parser. Uses --test-pattern only: no ScreenCaptureKit,
// no Screen Recording grant, no iPhone. Skipped when the helper has not been
// built (node scripts/build-capture.mjs) or outside a macOS GUI session (the
// helper creates its background-only NSApplication at startup).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HelperStreamParser, type HelperFrameHeader, type HelperMessage } from '../../src/device/live-capture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const helper = path.join(repoRoot, 'src-tauri', 'binaries', `iphone-ai-capture-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`);
const guiSession = process.platform === 'darwin' && spawnSync('/bin/launchctl', ['managername']).stdout?.toString().trim() === 'Aqua';

interface Run {
  messages: HelperMessage[];
  stderr: string;
  exitCode: number | null;
  pendingBytes: number;
}

/** Runs the helper's test pattern for `ms`, then closes stdin (the backend's normal stop). */
async function runTestPattern(args: string[], ms: number): Promise<Run> {
  const child = spawn(helper, ['--test-pattern', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const parser = new HelperStreamParser();
  const messages: HelperMessage[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => messages.push(...parser.push(chunk)));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise((resolve) => setTimeout(resolve, ms));
  child.stdin.end();
  const killer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const exitCode = await exited;
  clearTimeout(killer);
  return { messages, stderr, exitCode, pendingBytes: parser.pendingBytes };
}

function frames(run: Run): { header: HelperFrameHeader; jpeg: Buffer }[] {
  return run.messages.flatMap((m) => (m.type === 'frame' ? [{ header: m.header, jpeg: m.jpeg }] : []));
}

describe.skipIf(!existsSync(helper) || !guiSession)('real capture helper speaks the backend protocol', () => {
  it('streams decodable JPEG frames at the snapshot pace and stops cleanly on stdin EOF', async () => {
    // The pattern moves for the first 2 s of every 5 s cycle.
    const run = await runTestPattern(['--fps', '10'], 2500);

    expect(run.exitCode).toBe(0);
    expect(run.pendingBytes).toBe(0);
    const statuses = run.messages.flatMap((m) => (m.type === 'status' ? [m.status.event] : []));
    expect(statuses[0]).toBe('started');
    expect(statuses.at(-1)).toBe('stopped');
    expect(run.messages.some((m) => m.type === 'unknown')).toBe(false);

    const sent = frames(run);
    expect(sent.length).toBeGreaterThanOrEqual(12);
    expect(sent.length).toBeLessThanOrEqual(30);
    for (const [i, { header, jpeg }] of sent.entries()) {
      expect(header.ptW).toBeGreaterThan(0);
      expect(header.ptH).toBeGreaterThan(0);
      expect(header.pxW).toBeGreaterThan(0);
      expect(header.pxH).toBeGreaterThan(0);
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
      if (i > 0) {
        expect(header.seq).toBe(sent[i - 1]!.header.seq + 1);
        expect(header.ts).toBeGreaterThanOrEqual(sent[i - 1]!.header.ts);
      }
    }
  }, 20_000);

  it('caps snapshot capture at 15 fps', async () => {
    const run = await runTestPattern(['--fps', '30'], 1800);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toMatch(/out of range 1-15 in snapshot mode; using 15/);
    const sent = frames(run);
    expect(sent.length).toBeGreaterThan(0);
    const first = sent[0]!.header.ts;
    const inFirstSecond = sent.filter(({ header }) => header.ts - first < 1000).length;
    expect(inFirstSecond).toBeLessThanOrEqual(17);
    expect(inFirstSecond).toBeGreaterThanOrEqual(8);
  }, 20_000);
});
