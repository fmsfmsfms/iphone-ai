#!/usr/bin/env node
// Builds the ScreenCaptureKit live-view helper (src-tauri/capture/main.swift) into
// src-tauri/binaries/iphone-ai-capture-<rust target triple>, the name Tauri expects for
// the `binaries/iphone-ai-capture` externalBin (bundled as Contents/MacOS/iphone-ai-capture
// and re-signed there with the app identity). The local copy is ad-hoc signed so it also
// runs from the repo (development backend fallback).
//
//   node scripts/build-capture.mjs [--force] [--target aarch64-apple-darwin|x86_64-apple-darwin]
//
// Skips the compile when the source, compiler and flags are unchanged (use --force to
// rebuild). Run automatically by `pnpm package:mac` (also with --stage-only).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src-tauri', 'capture', 'main.swift');
const binariesDir = path.join(root, 'src-tauri', 'binaries');
export const CAPTURE_NAME = 'iphone-ai-capture';
const MIN_MACOS = '15.0';
const SIGNING_IDENTIFIER = 'me.alsaud.iphoneai.capture';
const FRAMEWORKS = ['ScreenCaptureKit', 'CoreImage', 'CoreMedia', 'AppKit'];
const SWIFT_TARGETS = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64' };

class CaptureBuildError extends Error {}

/** The Rust triple of this machine (what `tauri build` targets by default). */
export function hostTriple() {
  const triple = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[process.arch];
  if (!triple) throw new CaptureBuildError(`unsupported architecture ${process.arch}`);
  return triple;
}

export function captureBinaryPath(triple = hostTriple()) {
  return path.join(binariesDir, `${CAPTURE_NAME}-${triple}`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  };
}

/**
 * Compiles, ad-hoc signs and smoke-tests the helper. Returns
 * `{ path, triple, built, sizeBytes }` (`built` is false when the cached binary was current).
 */
export function buildCapture({ force = false, target = hostTriple(), log = console.log } = {}) {
  if (process.platform !== 'darwin') throw new CaptureBuildError('the capture helper can only be built on macOS.');
  const arch = SWIFT_TARGETS[target];
  if (!arch) throw new CaptureBuildError(`unsupported target ${target} (expected ${Object.keys(SWIFT_TARGETS).join(' or ')})`);
  if (!existsSync(source)) throw new CaptureBuildError(`${path.relative(root, source)} is missing.`);
  if (!existsSync('/usr/bin/xcrun')) {
    throw new CaptureBuildError('xcrun not found — install the Xcode Command Line Tools (xcode-select --install).');
  }
  const version = capture('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '--version']);
  if (!version.ok) {
    throw new CaptureBuildError(
      `swiftc is not available (${(version.error?.message ?? version.output).trim()}). ` +
        'Install the Xcode Command Line Tools (xcode-select --install).',
    );
  }

  const destination = captureBinaryPath(target);
  const flags = [
    '-O',
    '-swift-version',
    '5',
    '-target',
    `${arch}-apple-macos${MIN_MACOS}`,
    '-parse-as-library',
    ...FRAMEWORKS.flatMap((name) => ['-framework', name]),
  ];
  const stampFile = path.join(binariesDir, `.${CAPTURE_NAME}-${target}.stamp`);
  const stamp = createHash('sha256')
    .update(readFileSync(source))
    .update('\0')
    .update(flags.join(' '))
    .update('\0')
    .update(version.output)
    .update('\0')
    .update(SIGNING_IDENTIFIER)
    .digest('hex');
  let previousStamp = null;
  try {
    previousStamp = readFileSync(stampFile, 'utf8').trim();
  } catch {
    previousStamp = null;
  }
  if (!force && previousStamp === stamp && existsSync(destination) && smokeTest(destination).ok) {
    log(`  ${path.relative(root, destination)} is up to date (source unchanged)`);
    return { path: destination, triple: target, built: false, sizeBytes: statSync(destination).size };
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'iphone-ai-capture-'));
  try {
    const compiled = path.join(workDir, CAPTURE_NAME);
    const args = ['--sdk', 'macosx', 'swiftc', ...flags, '-o', compiled, source];
    log(`  $ xcrun ${args.join(' ')}`);
    const compile = capture('/usr/bin/xcrun', args, { timeout: 600_000 });
    if (compile.output.trim()) log(compile.output.trim().replace(/^/gm, '    '));
    if (!compile.ok) throw new CaptureBuildError(`swiftc failed (${compile.error?.message ?? `exit ${compile.status}`}).`);

    // Ad-hoc signature for local runs; `tauri build` re-signs the bundled copy with the app identity.
    const sign = capture('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', SIGNING_IDENTIFIER, '--options', 'runtime', compiled]);
    if (!sign.ok) throw new CaptureBuildError(`ad-hoc signing failed: ${sign.output.trim()}`);

    const smoke = smokeTest(compiled);
    if (!smoke.ok) throw new CaptureBuildError(`the compiled helper did not run: ${smoke.detail}`);

    mkdirSync(binariesDir, { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}`;
    copyFileSync(compiled, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
    writeFileSync(stampFile, `${stamp}\n`);
    const sizeBytes = statSync(destination).size;
    log(`  built ${path.relative(root, destination)} (${(sizeBytes / 1024).toFixed(0)} KB, ${arch}, macOS ${MIN_MACOS}+, ad-hoc signed)`);
    return { path: destination, triple: target, built: true, sizeBytes };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** `--help` must exit 0 and print the usage (never touches ScreenCaptureKit). */
export function smokeTest(binary) {
  const result = capture(binary, ['--help'], { timeout: 15_000 });
  if (result.ok && result.stdout.includes(`usage: ${CAPTURE_NAME}`)) return { ok: true, detail: 'ok' };
  return { ok: false, detail: (result.error?.message ?? `exit ${result.status}: ${result.output}`).trim() };
}

function parseArgs(argv) {
  const options = { force: false, target: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    else if (arg === '--force') options.force = true;
    else if (arg === '--target') options.target = argv[++i];
    else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
    else if (arg === '-h' || arg === '--help') {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
      const header = lines.slice(0, lines.findIndex((line) => !line.startsWith('//')));
      console.log(header.map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else throw new CaptureBuildError(`unknown option ${arg} (see --help)`);
  }
  if (options.target === '') throw new CaptureBuildError('--target needs a value');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    buildCapture({ force: options.force, target: options.target ?? hostTriple() });
  } catch (error) {
    console.error(`build-capture failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
