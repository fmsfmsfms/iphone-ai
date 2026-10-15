#!/usr/bin/env node
// `pnpm package:mac`: builds release/iPhone AI.app.
//
//   1. web UI          pnpm --filter @iphone-ai/web build            -> packages/web/dist
//   2. backend         node packages/server/scripts/bundle.mjs       -> packages/server/dist/server.mjs
//   3. resources       src-tauri/resources/{server,web,claude-code}  (recreated)
//   4. Node runtime    official Node.js 22 from nodejs.org (SHA-256 + signature verified) -> src-tauri/binaries/node-<triple>
//   5. helpers         src-tauri/capture/main.swift (swiftc, ScreenCaptureKit live view; scripts/build-capture.mjs)
//                      -> src-tauri/binaries/iphone-ai-capture-<triple>, and src-tauri/input/main.swift (the glide
//                      swipe; scripts/build-input.mjs) -> src-tauri/binaries/iphone-ai-input-<triple>
//                      (externalBins, ad-hoc signed until bundled)
//   6. Claude Code     Agent SDK native binary -> src-tauri/resources/claude-code/claude
//   7. signing         APPLE_SIGNING_IDENTITY, else Developer ID / Apple Development, else ad-hoc
//   8. bundle          pnpm tauri build --bundles app (signs node + both helpers with the app identity)
//   9. release         copy to release/iPhone AI.app, remove the intermediate src-tauri/target/*/bundle/macos copies,
//                      verify the signatures and the bundled helpers (the live-view helper must check in with
//                      LaunchServices as BackgroundOnly), print a summary
//
// Spotlight indexes app bundles inside ~/Documents and registers them with LaunchServices within
// seconds, so every copy left in the repo is offered as "iPhone AI" in Spotlight and the Dock's app
// list — and none of them can start there (the shell refuses protected folders). The build removes
// the intermediate copies and unregisters them; with --install it also removes release/iPhone AI.app.
//
// Options:
//   --no-claude-code          leave out the ~240 MB Claude Code binary (the "Claude Code login"
//                             provider is then unavailable)
//   --stage-only              stop after step 6 (enough for `cargo check` / `cargo run` in src-tauri)
//   --debug                   build the debug profile (faster compile, larger app)
//   --allow-unofficial-node   accept a node binary that is not signed by the Node.js Foundation
//   --install                 also install the app to /Applications/iPhone AI.app (refused while it is running or
//                             when the build failed verification), then remove release/iPhone AI.app. Launch it
//                             from there: macOS blocks apps inside ~/Documents, ~/Desktop or ~/Downloads from
//                             reading their own bundled server until a privacy prompt is answered.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildCapture, CAPTURE_NAME, smokeTest as captureSmokeTest } from './build-capture.mjs';
import { buildInput, INPUT_NAME, smokeTestInput } from './build-input.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(root, 'src-tauri');
const resourcesDir = path.join(tauriDir, 'resources');
const serverDir = path.join(root, 'packages', 'server');
const webDist = path.join(root, 'packages', 'web', 'dist');
const releaseDir = path.join(root, 'release');
const APP_NAME = 'iPhone AI.app';
const BUNDLE_ID = 'me.alsaud.iphoneai';
const EXPECTED_NODE = 'v22.22.3';
const NODE_AUTHORITY = 'Authority=Developer ID Application: Node.js Foundation';
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
/** What the live-view helper prints on stderr when its embedded Info.plist is not in effect (capture/main.swift). */
const BACKGROUND_ONLY_WARNING = 'the embedded Info.plist is not in effect';
const CLAUDE_PACKAGE = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;

// ── output helpers ──────────────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const TOTAL_STEPS = 9;
function step(n, title) {
  console.log(`\n${cyan(`▸ [${n}/${TOTAL_STEPS}]`)} ${bold(title)}`);
}
function info(message) {
  console.log(`  ${message}`);
}
function warn(message) {
  console.warn(`  ${yellow('warning:')} ${message}`);
}
function loud(lines) {
  const width = Math.max(...lines.map((line) => line.length));
  console.warn(yellow(`\n  ┏${'━'.repeat(width + 2)}┓`));
  for (const line of lines) console.warn(yellow(`  ┃ ${line.padEnd(width)} ┃`));
  console.warn(yellow(`  ┗${'━'.repeat(width + 2)}┛\n`));
}

class BuildError extends Error {}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function rel(file) {
  const relative = path.relative(root, file);
  return relative.startsWith('..') ? file : relative;
}

// ── process helpers ─────────────────────────────────────────────────────────
function run(command, args, options = {}) {
  console.log(dim(`  $ ${[command, ...args].join(' ')}`));
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw new BuildError(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new BuildError(`${command} ${args.join(' ')} failed (${result.signal ?? `exit ${result.status}`})`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  };
}

/** Runs a command with live output while keeping a copy for error analysis. */
function runTee(command, args, env) {
  console.log(dim(`  $ ${[command, ...args].join(' ')}`));
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error) => resolve({ ok: false, output: `${output}\n${error.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

function dirSize(dir) {
  const result = capture('/usr/bin/du', ['-sk', dir]);
  const kb = Number.parseInt(result.output, 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

// ── options ─────────────────────────────────────────────────────────────────
function parseOptions(argv) {
  const options = { claudeCode: true, stageOnly: false, debug: false, allowUnofficialNode: false, install: false };
  for (const arg of argv) {
    if (arg === '--') continue; // `pnpm package:mac -- --flag` passes the separator through
    else if (arg === '--no-claude-code') options.claudeCode = false;
    else if (arg === '--stage-only') options.stageOnly = true;
    else if (arg === '--debug') options.debug = true;
    else if (arg === '--allow-unofficial-node') options.allowUnofficialNode = true;
    else if (arg === '--install') options.install = true;
    else if (arg === '-h' || arg === '--help') {
      const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
      const header = lines.slice(0, lines.findIndex((line) => !line.startsWith('//')));
      console.log(header.map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else throw new BuildError(`unknown option ${arg} (see --help)`);
  }
  return options;
}

// ── steps ───────────────────────────────────────────────────────────────────
function checkPrerequisites(options) {
  if (process.platform !== 'darwin') throw new BuildError('packaging is only supported on macOS.');
  if (!existsSync(path.join(serverDir, 'src', 'main.ts'))) {
    throw new BuildError('packages/server/src/main.ts is missing.');
  }
  if (!existsSync('/usr/bin/codesign')) throw new BuildError('codesign not found (install the Xcode Command Line Tools).');
  if (!capture('/usr/bin/xcrun', ['--sdk', 'macosx', '--find', 'swiftc']).ok) {
    throw new BuildError('swiftc not found — install the Xcode Command Line Tools (xcode-select --install); it builds the live-view helper.');
  }
  if (!options.stageOnly && !capture('cargo', ['--version']).ok) {
    throw new BuildError('cargo not found — install Rust (https://rustup.rs) to build the app shell.');
  }
  if (!existsSync(path.join(tauriDir, 'icons', 'icon.icns'))) {
    throw new BuildError('src-tauri/icons/icon.icns is missing — run `node scripts/generate-icon.mjs`.');
  }
}

function buildWeb() {
  step(1, 'Building the web UI');
  run('pnpm', ['--filter', '@iphone-ai/web', 'build']);
  if (!existsSync(path.join(webDist, 'index.html'))) throw new BuildError('packages/web/dist/index.html was not produced.');
}

function bundleServer() {
  step(2, 'Bundling the backend');
  run(process.execPath, [path.join(serverDir, 'scripts', 'bundle.mjs')]);
}

function stageResources() {
  step(3, 'Staging app resources');
  for (const name of ['server', 'web', 'claude-code']) {
    rmSync(path.join(resourcesDir, name), { recursive: true, force: true });
    mkdirSync(path.join(resourcesDir, name), { recursive: true });
  }
  const bundle = path.join(serverDir, 'dist', 'server.mjs');
  copyFileSync(bundle, path.join(resourcesDir, 'server', 'server.mjs'));
  if (existsSync(`${bundle}.map`)) copyFileSync(`${bundle}.map`, path.join(resourcesDir, 'server', 'server.mjs.map'));
  cpSync(webDist, path.join(resourcesDir, 'web'), { recursive: true });
  info(`server  ${formatBytes(statSync(bundle).size)}  -> ${rel(path.join(resourcesDir, 'server'))}/`);
  info(`web     ${formatBytes(dirSize(webDist))}  -> ${rel(path.join(resourcesDir, 'web'))}/`);
}

function rustHostTriple() {
  const result = capture('rustc', ['--print', 'host-tuple']);
  return result.ok ? result.output.trim() : null;
}

/**
 * Stages the OFFICIAL Node.js runtime downloaded from nodejs.org (never the
 * node that happens to run this script, which may belong to another tool):
 * the tarball's SHA-256 must match nodejs.org's SHASUMS256.txt and the binary
 * must carry the Node.js Foundation's Developer ID signature.
 */
async function stageNode(options) {
  step(4, `Staging the official Node.js ${EXPECTED_NODE} runtime from nodejs.org`);
  const archName = { arm64: 'arm64', x64: 'x64' }[process.arch];
  const archTriple = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[process.arch];
  if (!archName || !archTriple) throw new BuildError(`unsupported architecture ${process.arch}`);
  const rustTriple = rustHostTriple();
  if (rustTriple && rustTriple !== archTriple) {
    warn(`node is ${archTriple} but rustc builds for ${rustTriple}; the app would not run node.`);
  }

  const dist = `https://nodejs.org/dist/${EXPECTED_NODE}`;
  const tarName = `node-${EXPECTED_NODE}-darwin-${archName}.tar.gz`;
  const cacheDir = path.join(root, '.cache', 'node');
  mkdirSync(cacheDir, { recursive: true });
  const tarPath = path.join(cacheDir, tarName);

  const shasums = await fetchText(`${dist}/SHASUMS256.txt`);
  const line = shasums.split('\n').find((l) => l.trim().endsWith(`  ${tarName}`));
  if (!line) throw new BuildError(`${tarName} is not listed in ${dist}/SHASUMS256.txt`);
  const expected = line.trim().split(/\s+/)[0];

  if (!existsSync(tarPath) || sha256File(tarPath) !== expected) {
    info(`downloading ${dist}/${tarName}`);
    const res = await fetch(`${dist}/${tarName}`);
    if (!res.ok) throw new BuildError(`download failed: HTTP ${res.status}`);
    writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
  } else {
    info(`using cached ${rel(tarPath)}`);
  }
  const actual = sha256File(tarPath);
  if (actual !== expected) {
    rmSync(tarPath, { force: true });
    throw new BuildError(`SHA-256 mismatch for ${tarName}: expected ${expected}, got ${actual}`);
  }
  info(`sha256 ${actual} matches nodejs.org SHASUMS256.txt ✓`);

  const extractDir = mkdtempSync(path.join(os.tmpdir(), 'iphone-ai-node-'));
  const member = `node-${EXPECTED_NODE}-darwin-${archName}/bin/node`;
  const untar = spawnSync('/usr/bin/tar', ['-xzf', tarPath, '-C', extractDir, member], { encoding: 'utf8' });
  if (untar.status !== 0) throw new BuildError(`could not extract ${member}: ${untar.stderr}`);
  const nodePath = path.join(extractDir, member);

  const signature = capture('/usr/bin/codesign', ['-dvv', nodePath]);
  if (!signature.output.includes(NODE_AUTHORITY)) {
    const message = `${member} is not signed by the Node.js Foundation`;
    if (!options.allowUnofficialNode) throw new BuildError(`${message}; refusing to bundle it.`);
    warn(message);
  } else {
    info('signature: Developer ID Application: Node.js Foundation ✓');
  }
  const version = spawnSync(nodePath, ['--version'], { encoding: 'utf8' }).stdout.trim();
  if (version !== EXPECTED_NODE) throw new BuildError(`extracted node reports ${version}, expected ${EXPECTED_NODE}`);

  const destination = path.join(tauriDir, 'binaries', `node-${archTriple}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  rmSync(destination, { force: true });
  copyFileSync(nodePath, destination);
  chmodSync(destination, 0o755);
  rmSync(extractDir, { recursive: true, force: true });
  info(`${formatBytes(statSync(destination).size)} -> ${rel(destination)}`);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new BuildError(`GET ${url} failed: HTTP ${res.status}`);
  return res.text();
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Step 5: the ScreenCaptureKit live-view helper and the input (glide swipe) helper, named for the Rust target `tauri build` uses. */
function stageCaptureHelper() {
  step(5, 'Building the live-view and input helpers');
  const archTriple = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[process.arch];
  const rustTriple = rustHostTriple();
  const target = rustTriple === 'aarch64-apple-darwin' || rustTriple === 'x86_64-apple-darwin' ? rustTriple : archTriple;
  if (!target) throw new BuildError(`unsupported architecture ${process.arch}`);
  try {
    const result = buildCapture({ target, log: (line) => console.log(dim(line)) });
    info(`${formatBytes(result.sizeBytes)} -> ${rel(result.path)}${result.built ? '' : ' (cached)'}`);
    info('--help runs ✓ (the bundled copy is re-signed with the app identity by tauri build)');
  } catch (error) {
    throw new BuildError(`capture helper: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const result = buildInput({ target, log: (line) => console.log(dim(line)) });
    info(`${formatBytes(result.sizeBytes)} -> ${rel(result.path)}${result.built ? '' : ' (cached)'}`);
  } catch (error) {
    throw new BuildError(`input helper: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveClaudeCodeBinary() {
  const serverRequire = createRequire(path.join(serverDir, 'package.json'));
  try {
    return serverRequire.resolve(`${CLAUDE_PACKAGE}/claude`);
  } catch {
    // pnpm keeps the platform package next to the SDK, not under packages/server.
    const sdkEntry = serverRequire.resolve('@anthropic-ai/claude-agent-sdk');
    return createRequire(sdkEntry).resolve(`${CLAUDE_PACKAGE}/claude`);
  }
}

function stageClaudeCode(options) {
  step(6, 'Staging the Claude Code binary (Claude Agent SDK provider)');
  const dir = path.join(resourcesDir, 'claude-code');
  if (!options.claudeCode) {
    writeFileSync(
      path.join(dir, 'README.md'),
      [
        '# Claude Code binary not bundled',
        '',
        'This build was packaged with `--no-claude-code`, so the "Claude Code login" AI provider',
        '(Claude Agent SDK) is unavailable. The Anthropic API, OpenAI and local providers work as usual.',
        'Rebuild with `pnpm package:mac` to include it.',
        '',
      ].join('\n'),
    );
    info('skipped (--no-claude-code); wrote claude-code/README.md');
    return;
  }
  let source;
  try {
    source = realpathSync(resolveClaudeCodeBinary());
  } catch (error) {
    throw new BuildError(
      `could not find ${CLAUDE_PACKAGE}/claude (${error instanceof Error ? error.message : error}). ` +
        'Reinstall without --omit=optional, or pass --no-claude-code.',
    );
  }
  const destination = path.join(dir, 'claude');
  copyFileSync(source, destination); // realpath: copies the file, not the pnpm symlink
  chmodSync(destination, 0o755);
  const signature = capture('/usr/bin/codesign', ['-dvv', destination]).output;
  const identifier = /^Identifier=(.+)$/m.exec(signature)?.[1] ?? 'unsigned';
  info(`${formatBytes(statSync(destination).size)} from ${source}`);
  info(`signature identifier: ${identifier} (kept unmodified; Tauri does not re-sign resources)`);
  info(dim('note: this adds ~240 MB to the app; use --no-claude-code if you will not use the Claude Code provider.'));
}

function listIdentities() {
  const result = capture('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = [];
  for (const match of result.output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)) {
    identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

/** Signs a scratch copy of /usr/bin/true to find out early whether the key is usable. */
function signingWorks(identity) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'iphone-ai-sign-'));
  try {
    const probe = path.join(dir, 'probe');
    copyFileSync('/usr/bin/true', probe);
    const result = capture('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', probe], {
      timeout: 180_000,
    });
    return { ok: result.ok, detail: result.error?.message ?? result.output.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function adHocWarning(reason) {
  loud([
    'AD-HOC SIGNING' + (reason ? ` (${reason})` : ''),
    '',
    'macOS ties Screen Recording, Accessibility and Automation grants to the',
    'code signature. An ad-hoc signature changes on every build, so after each',
    'rebuild you must re-grant iPhone AI in System Settings (remove and re-add it),',
    `or reset: tccutil reset ScreenCapture ${BUNDLE_ID}`,
    `          tccutil reset Accessibility ${BUNDLE_ID}`,
    `          tccutil reset AppleEvents ${BUNDLE_ID}`,
    'Set APPLE_SIGNING_IDENTITY or install an "Apple Development" certificate',
    '(free, via Xcode) for grants that survive rebuilds.',
  ]);
}

function chooseIdentity() {
  step(7, 'Choosing a signing identity');
  let identity = process.env.APPLE_SIGNING_IDENTITY?.trim() ?? '';
  let source = 'APPLE_SIGNING_IDENTITY';
  if (!identity) {
    const identities = listIdentities();
    const pick =
      identities.find((id) => id.name.startsWith('Developer ID Application:')) ??
      identities.find((id) => id.name.startsWith('Apple Development:'));
    if (pick) {
      const ambiguous = identities.filter((id) => id.name === pick.name).length > 1;
      identity = ambiguous ? pick.hash : pick.name;
      source = 'keychain';
    } else {
      identity = '-';
      source = 'no code-signing identity found';
    }
  }
  if (identity !== '-') {
    info(`identity: ${identity} (${source})`);
    info(dim('checking that the key is usable (macOS may ask to allow codesign — choose "Always Allow")…'));
    const probe = signingWorks(identity);
    if (!probe.ok) {
      warn(`signing with "${identity}" failed: ${probe.detail || 'unknown error'}`);
      adHocWarning('signing identity unusable');
      return '-';
    }
    info('signing check passed ✓');
    return identity;
  }
  adHocWarning(source === 'APPLE_SIGNING_IDENTITY' ? '' : source);
  return '-';
}

const SIGNING_FAILURE = /failed to sign|codesign|errSec|signing identity|keychain/i;

async function buildApp(identity, options) {
  step(8, `Building ${APP_NAME} (${options.debug ? 'debug' : 'release'})`);
  const args = ['tauri', 'build', '--bundles', 'app', '--ci', ...(options.debug ? ['--debug'] : [])];
  const env = { ...process.env, APPLE_SIGNING_IDENTITY: identity };
  let result = await runTee('pnpm', args, env);
  if (!result.ok && identity !== '-' && SIGNING_FAILURE.test(result.output.split('\n').slice(-40).join('\n'))) {
    warn(`the build failed while signing with "${identity}"; retrying once with ad-hoc signing.`);
    adHocWarning('signing failed during the build');
    identity = '-';
    result = await runTee('pnpm', args, { ...process.env, APPLE_SIGNING_IDENTITY: identity });
  }
  if (!result.ok) throw new BuildError('tauri build failed (see the output above).');
  return identity;
}

/** Returns whether the build passed verification (only a verified build may be installed). */
async function release(identity, options) {
  step(9, 'Copying to release/ and verifying');
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(tauriDir, 'target');
  const built = path.join(targetDir, options.debug ? 'debug' : 'release', 'bundle', 'macos', APP_NAME);
  if (!existsSync(built)) throw new BuildError(`expected bundle not found: ${built}`);
  mkdirSync(releaseDir, { recursive: true });
  const app = path.join(releaseDir, APP_NAME);
  rmSync(app, { recursive: true, force: true });
  run('/usr/bin/ditto', [built, app]); // preserves signatures, symlinks and xattrs
  for (const dir of new Set([targetDir, path.join(tauriDir, 'target')])) {
    for (const profile of ['release', 'debug']) {
      const copy = path.join(dir, profile, 'bundle', 'macos', APP_NAME);
      if (discardBuildCopy(copy)) info(dim(`removed the intermediate ${rel(copy)} (Spotlight would offer it as an app)`));
    }
  }

  const verify = capture('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const claudeOnly = !verify.ok && /claude-code/.test(verify.output) && !/MacOS\/(node|iphone-ai)/.test(verify.output);
  const nodeCheck = capture(path.join(app, 'Contents', 'MacOS', 'node'), ['-e', 'process.stdout.write(process.version)']);
  const details = capture('/usr/bin/codesign', ['-dvv', app]).output;
  const requirement = capture('/usr/bin/codesign', ['-d', '-r-', app]).output.match(/designated => .*/)?.[0] ?? 'unknown';
  const authority = details.match(/^Authority=.*$/m)?.[0]?.replace('Authority=', '') ?? (details.includes('Signature=adhoc') ? 'ad-hoc' : 'unknown');

  // Remember the identity: switching identities invalidates earlier privacy grants.
  const infoFile = path.join(releaseDir, '.build-info.json');
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(infoFile, 'utf8'));
  } catch {
    previous = null;
  }
  writeFileSync(
    infoFile,
    `${JSON.stringify({ identity, authority, builtAt: new Date().toISOString(), claudeCode: options.claudeCode }, null, 2)}\n`,
  );

  console.log(`\n${green('✓')} ${bold(rel(app))}`);
  info(`size:      ${formatBytes(dirSize(app))}`);
  info(`signed by: ${authority}${identity === '-' ? '' : ` (identity "${identity}")`}`);
  info(`requirement: ${requirement}`);
  info(`Claude Code binary: ${options.claudeCode ? 'included' : 'not included (--no-claude-code)'}`);
  if (nodeCheck.ok && nodeCheck.output.startsWith('v')) {
    info(`bundled node runs under the hardened runtime: ${nodeCheck.output} ✓`);
  } else {
    warn(`the bundled node did not run (${nodeCheck.status ?? nodeCheck.error?.message}); check Entitlements.plist (allow-jit).`);
  }
  const helperCheck = await verifyCaptureHelper(app);
  if (helperCheck.ok) {
    info(
      `live-view helper: signed by ${helperCheck.signature.authority} (hardened runtime), --help ✓, ` +
        `embedded Info.plist LSBackgroundOnly ✓, stdin closed -> ${helperCheck.outcome} ✓` +
        (helperCheck.backgroundOnly.skipped ? '' : `, checks in as type="${helperCheck.backgroundOnly.type}" ✓`),
    );
    if (helperCheck.backgroundOnly.skipped) warn('live-view helper LaunchServices check skipped: no GUI session');
  } else {
    console.error(red(`  live-view helper (Contents/MacOS/${CAPTURE_NAME}) FAILED verification:`));
    for (const problem of helperCheck.problems) console.error(dim(`    - ${problem}`));
    process.exitCode = 1;
  }
  const inputCheck = verifyInputHelper(app);
  if (inputCheck.ok) {
    info(`input helper: signed by ${inputCheck.signature.authority} (hardened runtime), --help ✓, embedded Info.plist LSBackgroundOnly ✓, --dry-run ✓`);
  } else {
    console.error(red(`  input helper (Contents/MacOS/${INPUT_NAME}) FAILED verification:`));
    for (const problem of inputCheck.problems) console.error(dim(`    - ${problem}`));
    process.exitCode = 1;
  }
  if (verify.ok) {
    info('codesign --verify --deep --strict: valid ✓');
  } else if (claudeOnly) {
    warn('codesign --verify reported a problem only with the bundled Claude Code binary (its own Anthropic signature):');
    console.warn(dim(verify.output.trim().replace(/^/gm, '    ')));
  } else {
    console.error(red('  codesign --verify --deep --strict FAILED:'));
    console.error(dim(verify.output.trim().replace(/^/gm, '    ')));
    process.exitCode = 1;
  }
  if (identity === '-') {
    adHocWarning('reminder');
  } else if (previous && previous.identity !== identity) {
    loud([
      `The signing identity changed (was "${previous.identity}").`,
      'Reset the old privacy grants once, then grant iPhone AI again:',
      `  tccutil reset ScreenCapture ${BUNDLE_ID}`,
      `  tccutil reset Accessibility ${BUNDLE_ID}`,
      `  tccutil reset AppleEvents ${BUNDLE_ID}`,
    ]);
  }
  if (!options.install) {
    info(dim('Tip: move it to /Applications and always launch that copy, so privacy grants stay attached to one path.'));
  }
  return helperCheck.ok && inputCheck.ok && (verify.ok || claudeOnly);
}

/**
 * The bundled input helper: signed like the app (hardened runtime), --help and the embedded
 * LSBackgroundOnly plist, and a --dry-run plan. Posts no input and needs no permission.
 */
function verifyInputHelper(app) {
  const helper = path.join(app, 'Contents', 'MacOS', INPUT_NAME);
  if (!existsSync(helper)) return { ok: false, problems: [`Contents/MacOS/${INPUT_NAME} is missing`] };
  const problems = [];
  const appSignature = signatureOf(app);
  const helperSignature = signatureOf(helper);
  if (helperSignature.authority !== appSignature.authority || helperSignature.team !== appSignature.team) {
    problems.push(
      `signed by "${helperSignature.authority}" (team ${helperSignature.team}), the app by "${appSignature.authority}" (team ${appSignature.team})`,
    );
  }
  if (!helperSignature.runtime) problems.push('not signed with the hardened runtime');
  const strict = capture('/usr/bin/codesign', ['--verify', '--strict', helper]);
  if (!strict.ok) problems.push(`codesign --verify failed: ${strict.output.trim()}`);
  const smoke = smokeTestInput(helper);
  if (!smoke.ok) problems.push(smoke.detail);
  const dry = capture(helper, ['glide', '--dx', '0', '--dy', '-100', '--dry-run'], { timeout: 15_000 });
  let plan = null;
  try {
    plan = JSON.parse(dry.output.trim().split('\n').pop() ?? '');
  } catch {
    plan = null;
  }
  if (!dry.ok || plan?.ok !== true || plan?.wheel?.[1] !== -300) problems.push(`--dry-run: ${dry.output.trim().slice(0, 200)}`);
  return { ok: problems.length === 0, problems, signature: helperSignature };
}

function signatureOf(file) {
  const out = capture('/usr/bin/codesign', ['-dvv', file]).output;
  return {
    authority: out.match(/^Authority=(.*)$/m)?.[1] ?? (out.includes('Signature=adhoc') ? 'ad-hoc' : 'unsigned'),
    team: out.match(/^TeamIdentifier=(.*)$/m)?.[1] ?? 'not set',
    runtime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(out),
  };
}

/** STATUS events from the helper's framed stdout (`[u32 BE length][type][payload]`). */
function captureStatusEvents(stdout) {
  const events = [];
  let offset = 0;
  while (offset + 5 <= stdout.length) {
    const length = stdout.readUInt32BE(offset);
    if (length < 1 || offset + 4 + length > stdout.length) return { events, valid: false };
    if (stdout[offset + 4] === 0x01) {
      try {
        events.push(JSON.parse(stdout.subarray(offset + 5, offset + 4 + length).toString('utf8')));
      } catch {
        return { events, valid: false };
      }
    }
    offset += 4 + length;
  }
  return { events, valid: offset === stdout.length };
}

/**
 * The bundled live-view helper: present, signed like the app (hardened runtime), `--help`
 * works, its embedded Info.plist declares LSBackgroundOnly and, started with stdin already
 * closed, it exits cleanly with valid framing: 0 + "stopped", or 2 + "permission" when
 * whatever runs this build lacks Screen Recording. In a GUI session it must also check in
 * with LaunchServices as BackgroundOnly (backgroundOnlyCheck).
 */
async function verifyCaptureHelper(app) {
  const helper = path.join(app, 'Contents', 'MacOS', CAPTURE_NAME);
  if (!existsSync(helper)) {
    return { ok: false, problems: [`Contents/MacOS/${CAPTURE_NAME} is missing`], backgroundOnly: { skipped: true } };
  }
  const problems = [];
  const appSignature = signatureOf(app);
  const helperSignature = signatureOf(helper);
  if (helperSignature.authority !== appSignature.authority || helperSignature.team !== appSignature.team) {
    problems.push(
      `signed by "${helperSignature.authority}" (team ${helperSignature.team}), the app by "${appSignature.authority}" (team ${appSignature.team})`,
    );
  }
  if (!helperSignature.runtime) problems.push('not signed with the hardened runtime');
  const strict = capture('/usr/bin/codesign', ['--verify', '--strict', helper]);
  if (!strict.ok) problems.push(`codesign --verify failed: ${strict.output.trim()}`);
  const smoke = captureSmokeTest(helper); // --help and the embedded Info.plist (LSBackgroundOnly)
  if (!smoke.ok) problems.push(smoke.detail);

  const run = spawnSync(helper, [], { input: '', timeout: 15_000 });
  const { events, valid } = captureStatusEvents(run.stdout ?? Buffer.alloc(0));
  const last = events.at(-1);
  let outcome = `exit ${run.status ?? run.signal ?? run.error?.message}`;
  if (run.error) problems.push(`did not run with stdin closed: ${run.error.message}`);
  else if (!valid) problems.push('wrote malformed framed output with stdin closed');
  else if (run.status === 0 && last?.event === 'stopped') outcome = 'exit 0, "stopped"';
  else if (run.status === 2 && last?.event === 'error' && last.code === 'permission') {
    outcome = 'exit 2, "permission" (Screen Recording is not granted to whatever runs this build; expected)';
  } else problems.push(`unexpected result with stdin closed: ${outcome}, last status ${JSON.stringify(last ?? null)}`);
  const backgroundOnly = await backgroundOnlyCheck(helper);
  problems.push(...backgroundOnly.problems);
  return { ok: problems.length === 0, problems, signature: helperSignature, outcome, backgroundOnly };
}

/**
 * Runs the helper with the test pattern (no ScreenCaptureKit, no permission needed) and asks
 * LaunchServices how it checked in: it must be BackgroundOnly. Without its embedded Info.plist
 * it checked in with the app's Info.plist as a second Foreground "iPhone AI" with its own Dock
 * icon. Needs a GUI (Aqua) session; elsewhere it is skipped.
 */
async function backgroundOnlyCheck(helper) {
  if (capture('/bin/launchctl', ['managername']).output.trim() !== 'Aqua') return { skipped: true, problems: [] };
  const problems = [];
  const child = spawn(helper, ['--test-pattern', '--fps', '1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    stderr += text;
  });
  child.stdin.on('error', () => undefined);
  const closed = new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  // Waits for the "started" STATUS while draining stdout (frames keep coming at 1 fps).
  const started = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    closed.then(() => settle(false));
    let pending = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const length = pending.readUInt32BE(0);
        if (pending[4] === 0x01) {
          try {
            if (JSON.parse(pending.subarray(5, 4 + length).toString('utf8')).event === 'started') settle(true);
          } catch {
            // not a STATUS this check cares about
          }
        }
        pending = pending.subarray(4 + Math.max(1, length));
      }
    });
  });
  let type = null;
  if (!started) {
    problems.push('the test pattern did not report "started" within 10 s, so its LaunchServices check-in was not checked');
  } else {
    type = /\btype="([^"]*)"/.exec(capture('/usr/bin/lsappinfo', ['info', String(child.pid)]).output)?.[1] ?? null;
    if (!type) problems.push('it never checked in with LaunchServices (lsappinfo shows no type; expected BackgroundOnly)');
    else if (type !== 'BackgroundOnly') {
      problems.push(`it checked in with LaunchServices as type="${type}", not BackgroundOnly: it would show in the Dock`);
    }
  }
  child.stdin.end();
  const kill = setTimeout(() => child.kill('SIGKILL'), 8_000);
  const result = await closed;
  clearTimeout(kill);
  if (result.error) problems.push(`the test pattern did not run: ${result.error.message}`);
  else if (result.code !== 0) {
    problems.push(`the test pattern did not exit cleanly after stdin closed (${result.signal ?? `exit ${result.code}`})`);
  }
  if (stderr.includes(BACKGROUND_ONLY_WARNING)) problems.push(`it warned on stderr that ${BACKGROUND_ONLY_WARNING}`);
  return { skipped: false, problems, type };
}

/**
 * Best effort: deletes a copy of the app that must not stay around and drops it from
 * LaunchServices. Spotlight indexes app bundles inside ~/Documents and registers them again
 * within seconds, so `lsregister -u` sticks only once the bundle is gone (never run it on a
 * copy that still exists). Returns whether a copy existed.
 */
function discardBuildCopy(app) {
  const existed = existsSync(app);
  try {
    rmSync(app, { recursive: true, force: true });
  } catch (error) {
    warn(`could not remove ${rel(app)} (${error instanceof Error ? error.message : error}); delete it so Spotlight stops offering it.`);
    return false;
  }
  capture(LSREGISTER, ['-u', app]); // fails harmlessly for a path LaunchServices never saw
  return existed;
}

/** Copies release/iPhone AI.app to /Applications (the only supported launch location). */
function installApp() {
  const source = path.join(releaseDir, APP_NAME);
  const target = path.join('/Applications', APP_NAME);
  const running = capture('/usr/bin/pgrep', ['-f', `${target}/Contents/MacOS/`]);
  if (running.ok && running.output.trim()) {
    throw new BuildError(`${target} is running. Quit iPhone AI, then run the install again.`);
  }
  if (existsSync(target)) {
    const plist = capture('/usr/bin/defaults', ['read', path.join(target, 'Contents', 'Info'), 'CFBundleIdentifier']);
    if (plist.output.trim() !== BUNDLE_ID) throw new BuildError(`${target} exists but is not iPhone AI (${plist.output.trim()}); not replacing it.`);
    rmSync(target, { recursive: true, force: true });
  }
  run('/usr/bin/ditto', [source, target]);
  const verify = capture('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  if (!verify.ok) throw new BuildError(`installed copy failed signature verification: ${verify.output}`);
  info(green(`installed ${target} ✓`));
  // The copy inside ~/Documents cannot start, but Spotlight would keep offering it.
  if (discardBuildCopy(source)) info(dim(`removed ${rel(source)}; launch ${target}`));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  checkPrerequisites(options);
  buildWeb();
  bundleServer();
  stageResources();
  await stageNode(options);
  stageCaptureHelper();
  stageClaudeCode(options);
  if (options.stageOnly) {
    console.log(`\n${green('✓')} staged. You can now run \`cargo check\` or \`cargo run\` in src-tauri.`);
    return;
  }
  const identity = await buildApp(chooseIdentity(), options);
  const verified = await release(identity, options);
  if (options.install) {
    if (!verified) {
      throw new BuildError(`the build failed verification (see above); not installing it. ${rel(path.join(releaseDir, APP_NAME))} was kept.`);
    }
    installApp();
  }
}

// Exported for scripted checks; running the file performs the build.
export {
  backgroundOnlyCheck,
  discardBuildCopy,
  listIdentities,
  parseOptions,
  resolveClaudeCodeBinary,
  stageCaptureHelper,
  stageClaudeCode,
  stageNode,
  verifyCaptureHelper,
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(red(`\npackage:mac failed: ${error instanceof Error ? error.message : String(error)}`));
    if (!(error instanceof BuildError) && error instanceof Error && error.stack) console.error(dim(error.stack));
    process.exit(1);
  });
}
