// The real Swift input helper (src-tauri/input/main.swift), dry runs only: it
// prints the planned gesture and posts nothing (no Accessibility, no window, no
// iPhone). Skipped when the helper has not been built (node scripts/build-input.mjs).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const helper = path.join(repoRoot, 'src-tauri', 'binaries', `iphone-ai-input-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`);

interface Plan {
  ok: boolean;
  dryRun: boolean;
  frames: number;
  frameMs: number;
  holdMs: number;
  wheel: [number, number];
  deltas: [number, number][];
}

function run(args: string[]) {
  const result = spawnSync(helper, args, { encoding: 'utf8', timeout: 15_000 });
  const line = result.stdout.trim().split('\n').pop() ?? '';
  let json: unknown = null;
  try {
    json = JSON.parse(line);
  } catch {
    json = null;
  }
  return { status: result.status, stdout: result.stdout, json };
}

describe.skipIf(process.platform !== 'darwin' || !existsSync(helper))('iphone-ai-input (real binary, dry run)', () => {
  it('prints its usage and version', () => {
    expect(run(['--help']).stdout).toContain('usage: iphone-ai-input glide --dx <pt> --dy <pt>');
    expect(run(['--version']).stdout.trim()).toBe('iphone-ai-input 1');
  });

  it('plans an ease-out glide: 3 wheel units per point, exact totals, slowing to a stop before the lift', () => {
    const { status, json } = run(['glide', '--dx', '0', '--dy', '-712', '--dry-run']);
    expect(status).toBe(0);
    const plan = json as Plan;
    expect(plan).toMatchObject({ ok: true, dryRun: true, frames: 31, frameMs: 8, holdMs: 40, wheel: [0, -2136] });
    const ys = plan.deltas.map(([, y]) => y);
    expect(ys.reduce((a, b) => a + b, 0)).toBe(-2136);
    for (let i = 1; i < ys.length; i++) expect(Math.abs(ys[i]!)).toBeLessThanOrEqual(Math.abs(ys[i - 1]!) + 1);
    expect(Math.abs(ys[0]!)).toBeGreaterThan(150); // fast start
    expect(Math.abs(ys.at(-1)!)).toBeLessThanOrEqual(1); // slow lift
  });

  it('plans diagonal and horizontal travel on both axes and clamps the gesture length', () => {
    const diagonal = run(['glide', '--dx', '-120', '--dy', '40.5', '--duration-ms', '5000', '--dry-run']).json as Plan;
    expect(diagonal.wheel).toEqual([-360, 122]);
    expect(diagonal.frames).toBe(125); // clamped to 1000 ms
    const xs = diagonal.deltas.map(([x]) => x);
    expect(xs.reduce((a, b) => a + b, 0)).toBe(-360);
  });

  it('refuses bad arguments with exit 64 and posts nothing', () => {
    expect(run(['glide', '--dy', '5', '--dry-run'])).toMatchObject({ status: 64, json: { ok: false, error: 'bad_args' } });
    expect(run(['tap', '--dry-run']).status).toBe(64);
    expect(run(['glide', '--dx', '0', '--dy', '9000', '--dry-run']).status).toBe(64);
    expect(run(['glide', '--dx', '0', '--dy', '0', '--dry-run']).status).toBe(64);
    expect(run(['glide', '--dx', 'x', '--dy', '1', '--dry-run']).status).toBe(64);
  });
});
