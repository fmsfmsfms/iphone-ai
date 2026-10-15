#!/usr/bin/env node
// Builds the ScreenCaptureKit live-view helper (src-tauri/capture/main.swift) into
// src-tauri/binaries/iphone-ai-capture-<rust target triple>, the name Tauri expects for
// the `binaries/iphone-ai-capture` externalBin (bundled as Contents/MacOS/iphone-ai-capture
// and re-signed there with the app identity). The local copy is ad-hoc signed so it also
// runs from the repo (development backend fallback).
//
// src-tauri/capture/Info.plist is embedded at link time (__TEXT,__info_plist): it declares
// LSBackgroundOnly, so the helper checks in with LaunchServices as a background-only process
// instead of as a second "iPhone AI" Dock app (see the comment in that file).
//
//   node scripts/build-capture.mjs [--force] [--target aarch64-apple-darwin|x86_64-apple-darwin]
//
// Skips the compile when the source, Info.plist, compiler and flags are unchanged (use
// --force to rebuild). Run automatically by `pnpm package:mac` (also with --stage-only).

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
const binariesDir = path.join(root, 'src-tauri', 'binaries');
export const CAPTURE_NAME = 'iphone-ai-capture';
const MIN_MACOS = '15.0';
const SWIFT_TARGETS = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64' };

/** The live-view helper; scripts/build-input.mjs builds the input helper with the same steps. */
const CAPTURE_SPEC = {
  name: CAPTURE_NAME,
  source: path.join(root, 'src-tauri', 'capture', 'main.swift'),
  infoPlist: path.join(root, 'src-tauri', 'capture', 'Info.plist'),
  signingIdentifier: 'me.alsaud.iphoneai.capture',
  frameworks: ['ScreenCaptureKit', 'CoreImage', 'CoreMedia', 'AppKit'],
  parseAsLibrary: true,
};

class CaptureBuildError extends Error {}

/** The Rust triple of this machine (what `tauri build` targets by default). */
export function hostTriple() {
  const triple = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[process.arch];
  if (!triple) throw new CaptureBuildError(`unsupported architecture ${process.arch}`);
  return triple;
}

export function helperBinaryPath(name, triple = hostTriple()) {
  return path.join(binariesDir, `${name}-${triple}`);
}

export function captureBinaryPath(triple = hostTriple()) {
  return helperBinaryPath(CAPTURE_NAME, triple);
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
 * Compiles, ad-hoc signs and smoke-tests the capture helper. Returns
 * `{ path, triple, built, sizeBytes }` (`built` is false when the cached binary was current).
 */
export function buildCapture(options = {}) {
  return buildSwiftHelper(CAPTURE_SPEC, options);
}

/**
 * Compiles, ad-hoc signs and smoke-tests a Swift helper described by `spec`
 * ({ name, source, infoPlist, signingIdentifier, frameworks, parseAsLibrary }).
 */
export function buildSwiftHelper(spec, { force = false, target = hostTriple(), log = console.log } = {}) {
  const { name, source, infoPlist } = spec;
  if (process.platform !== 'darwin') throw new CaptureBuildError(`${name} can only be built on macOS.`);
  const arch = SWIFT_TARGETS[target];
  if (!arch) throw new CaptureBuildError(`unsupported target ${target} (expected ${Object.keys(SWIFT_TARGETS).join(' or ')})`);
  for (const file of [source, infoPlist]) {
    if (!existsSync(file)) throw new CaptureBuildError(`${path.relative(root, file)} is missing.`);
  }
  const lint = capture('/usr/bin/plutil', ['-lint', infoPlist]);
  if (!lint.ok) throw new CaptureBuildError(`${path.relative(root, infoPlist)} is not a valid plist: ${lint.output.trim()}`);
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

  const destination = helperBinaryPath(name, target);
  const flags = [
    '-O',
    '-swift-version',
    '5',
    '-target',
    `${arch}-apple-macos${MIN_MACOS}`,
    ...(spec.parseAsLibrary ? ['-parse-as-library'] : []),
    ...spec.frameworks.flatMap((framework) => ['-framework', framework]),
    // One argv entry each (the repo path contains a space; never join and re-split these).
    ...['-sectcreate', '__TEXT', '__info_plist', infoPlist].flatMap((arg) => ['-Xlinker', arg]),
  ];
  const stampFile = path.join(binariesDir, `.${name}-${target}.stamp`);
  const stamp = createHash('sha256')
    .update(readFileSync(source))
    .update('\0')
    .update(readFileSync(infoPlist))
    .update('\0')
    .update(flags.join(' '))
    .update('\0')
    .update(version.output)
    .update('\0')
    .update(spec.signingIdentifier)
    .digest('hex');
  let previousStamp = null;
  try {
    previousStamp = readFileSync(stampFile, 'utf8').trim();
  } catch {
    previousStamp = null;
  }
  if (!force && previousStamp === stamp && existsSync(destination) && smokeTestHelper(destination, name).ok) {
    log(`  ${path.relative(root, destination)} is up to date (source unchanged)`);
    return { path: destination, triple: target, built: false, sizeBytes: statSync(destination).size };
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  try {
    const compiled = path.join(workDir, name);
    const args = ['--sdk', 'macosx', 'swiftc', ...flags, '-o', compiled, source];
    log(`  $ xcrun ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
    const compile = capture('/usr/bin/xcrun', args, { timeout: 600_000 });
    if (compile.output.trim()) log(compile.output.trim().replace(/^/gm, '    '));
    if (!compile.ok) throw new CaptureBuildError(`swiftc failed (${compile.error?.message ?? `exit ${compile.status}`}).`);

    // Ad-hoc signature for local runs; `tauri build` re-signs the bundled copy with the app identity.
    const sign = capture('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', spec.signingIdentifier, '--options', 'runtime', compiled]);
    if (!sign.ok) throw new CaptureBuildError(`ad-hoc signing failed: ${sign.output.trim()}`);

    const smoke = smokeTestHelper(compiled, name);
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

/**
 * `--help` must exit 0 and print the usage (never touches ScreenCaptureKit or the window
 * server), and the binary must carry the embedded Info.plist with LSBackgroundOnly.
 */
export function smokeTest(binary) {
  return smokeTestHelper(binary, CAPTURE_NAME);
}

export function smokeTestHelper(binary, name) {
  const result = capture(binary, ['--help'], { timeout: 15_000 });
  if (!result.ok || !result.stdout.includes(`usage: ${name}`)) {
    return { ok: false, detail: `--help: ${(result.error?.message ?? `exit ${result.status}: ${result.output}`).trim()}` };
  }
  return embeddedPlistCheck(binary);
}

/** The Info.plist linked into __TEXT,__info_plist must declare LSBackgroundOnly. */
export function embeddedPlistCheck(binary) {
  const plist = capture('/bin/launchctl', ['plist', '__TEXT,__info_plist', binary], { timeout: 15_000 });
  if (plist.ok && /"LSBackgroundOnly" = (true|1);/.test(plist.output)) return { ok: true, detail: 'ok' };
  const detail = (plist.error?.message ?? (plist.output.trim() || `exit ${plist.status}`)).replace(/\s+/g, ' ');
  return { ok: false, detail: `the embedded Info.plist does not declare LSBackgroundOnly (launchctl plist: ${detail})` };
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
