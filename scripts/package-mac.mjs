#!/usr/bin/env node
// `pnpm package:mac`: builds release/iPhone AI.app.
//
//   1. web UI          pnpm --filter @iphone-ai/web build            -> packages/web/dist
//   2. backend         node packages/server/scripts/bundle.mjs       -> packages/server/dist/server.mjs
//   3. resources       src-tauri/resources/{server,web,claude-code}  (recreated)
//   4. Node runtime    official Node.js 22 from nodejs.org (SHA-256 + signature verified) -> src-tauri/binaries/node-<triple>
//   5. Claude Code     Agent SDK native binary -> src-tauri/resources/claude-code/claude
//   6. signing         APPLE_SIGNING_IDENTITY, else Developer ID / Apple Development, else ad-hoc
//   7. bundle          pnpm tauri build --bundles app
//   8. release         copy to release/iPhone AI.app, verify the signature, print a summary
//
// Options:
//   --no-claude-code          leave out the ~240 MB Claude Code binary (the "Claude Code login"
//                             provider is then unavailable)
//   --stage-only              stop after step 5 (enough for `cargo check` / `cargo run` in src-tauri)
//   --debug                   build the debug profile (faster compile, larger app)
//   --allow-unofficial-node   accept a node binary that is not signed by the Node.js Foundation

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

const TOTAL_STEPS = 8;
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
  const options = { claudeCode: true, stageOnly: false, debug: false, allowUnofficialNode: false };
  for (const arg of argv) {
    if (arg === '--') continue; // `pnpm package:mac -- --flag` passes the separator through
    else if (arg === '--no-claude-code') options.claudeCode = false;
    else if (arg === '--stage-only') options.stageOnly = true;
    else if (arg === '--debug') options.debug = true;
    else if (arg === '--allow-unofficial-node') options.allowUnofficialNode = true;
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
  step(5, 'Staging the Claude Code binary (Claude Agent SDK provider)');
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
  step(6, 'Choosing a signing identity');
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
  step(7, `Building ${APP_NAME} (${options.debug ? 'debug' : 'release'})`);
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

function release(identity, options) {
  step(8, 'Copying to release/ and verifying');
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(tauriDir, 'target');
  const built = path.join(targetDir, options.debug ? 'debug' : 'release', 'bundle', 'macos', APP_NAME);
  if (!existsSync(built)) throw new BuildError(`expected bundle not found: ${built}`);
  mkdirSync(releaseDir, { recursive: true });
  const app = path.join(releaseDir, APP_NAME);
  rmSync(app, { recursive: true, force: true });
  run('/usr/bin/ditto', [built, app]); // preserves signatures, symlinks and xattrs

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
  info(dim('Tip: move it to /Applications and always launch that copy, so privacy grants stay attached to one path.'));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  checkPrerequisites(options);
  buildWeb();
  bundleServer();
  stageResources();
  await stageNode(options);
  stageClaudeCode(options);
  if (options.stageOnly) {
    console.log(`\n${green('✓')} staged. You can now run \`cargo check\` or \`cargo run\` in src-tauri.`);
    return;
  }
  const identity = await buildApp(chooseIdentity(), options);
  release(identity, options);
}

// Exported for scripted checks; running the file performs the build.
export { listIdentities, parseOptions, resolveClaudeCodeBinary, stageClaudeCode, stageNode };

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(red(`\npackage:mac failed: ${error instanceof Error ? error.message : String(error)}`));
    if (!(error instanceof BuildError) && error instanceof Error && error.stack) console.error(dim(error.stack));
    process.exit(1);
  });
}
