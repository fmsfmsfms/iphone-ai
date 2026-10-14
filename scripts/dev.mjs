#!/usr/bin/env node
// `pnpm dev`: runs the backend (tsx watch, http://127.0.0.1:47823, data in
// <repo>/.data unless IPHONE_AI_DATA_DIR is already set) and the Vite dev server (http://localhost:5173) together with
// prefixed logs. Each run gets a fresh desktop token; once the backend prints
// `LISTENING <port>` the sign-in URL is shown (Vite proxies /auth, /api and /ws
// to the backend). Ctrl-C stops both (a second Ctrl-C force-kills).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'packages', 'server');
const webDir = path.join(root, 'packages', 'web');
const dataDir = process.env.IPHONE_AI_DATA_DIR ? path.resolve(process.env.IPHONE_AI_DATA_DIR) : path.join(root, '.data');
const BACKEND_PORT = 47823;
const WEB_PORT = 5173;
const STOP_TIMEOUT_MS = 5000;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const cyan = paint('36');
const magenta = paint('35');

const token = randomBytes(32).toString('hex');
const signInUrl = `http://localhost:${WEB_PORT}/auth/desktop?token=${token}`;

/** @type {{ name: string, child: import('node:child_process').ChildProcess }[]} */
const services = [];
let stopping = false;
let exitCode = 0;
let listeningCount = 0;

function fail(message) {
  console.error(red(`dev: ${message}`));
  process.exit(1);
}

function binary(dir, name) {
  const file = path.join(dir, 'node_modules', '.bin', name);
  if (!existsSync(file)) fail(`${path.relative(root, file)} is missing — run \`pnpm install\` first.`);
  return file;
}

function portIsFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

function banner(lines) {
  const width = Math.max(...lines.map((line) => line.length));
  const rule = '─'.repeat(width + 4);
  console.log('');
  console.log(green(`┌${rule}┐`));
  for (const line of lines) console.log(`${green('│')}  ${bold(line.padEnd(width))}  ${green('│')}`);
  console.log(green(`└${rule}┘`));
  console.log('');
}

function onBackendLine(line) {
  const match = /^LISTENING (\d+)\s*$/.exec(line);
  if (!match) return;
  listeningCount += 1;
  if (listeningCount === 1) {
    banner([
      'iPhone AI is running (development)',
      '',
      `Open ${signInUrl}`,
      '',
      `Backend http://127.0.0.1:${match[1]}  ·  Ctrl-C to stop`,
      'The token changes every time `pnpm dev` starts.',
    ]);
  } else {
    console.log(green(`backend restarted on port ${match[1]} — sign in again if needed: ${signInUrl}`));
  }
}

function pipeLines(stream, prefix, onLine) {
  readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
    console.log(`${prefix} ${line}`);
    onLine?.(line);
  });
}

function start(name, tint, command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    // stdin stays an open pipe for the child's lifetime; each service gets its own
    // process group so Ctrl-C is handled here and the whole tree can be signalled.
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  const prefix = tint(`[${name}]`.padEnd(8));
  pipeLines(child.stdout, prefix, options.onLine);
  pipeLines(child.stderr, prefix);
  child.on('error', (error) => {
    console.error(`${prefix} ${red(`failed to start: ${error.message}`)}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${prefix} ${red(`exited (${signal ?? `code ${code}`}); stopping the other service`)}`);
    stopAll(code || 1);
  });
  services.push({ name, child });
  return child;
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone.
  }
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  console.log(dim('\nstopping backend and web…'));
  for (const { child } of services) signalGroup(child, 'SIGTERM');
  const pending = services.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  if (pending.length === 0) process.exit(exitCode);
  let remaining = pending.length;
  for (const { child } of pending) {
    child.once('exit', () => {
      remaining -= 1;
      if (remaining === 0) {
        // Grandchildren (e.g. Mirroir) share the group; make sure none is left behind.
        for (const service of services) signalGroup(service.child, 'SIGTERM');
        process.exit(exitCode);
      }
    });
  }
  setTimeout(() => {
    console.error(red('services did not stop in time; killing them'));
    for (const { child } of services) signalGroup(child, 'SIGKILL');
    process.exit(exitCode || 1);
  }, STOP_TIMEOUT_MS);
}

process.on('SIGINT', () => {
  if (stopping) {
    for (const { child } of services) signalGroup(child, 'SIGKILL');
    process.exit(130);
  }
  stopAll(0);
});
process.on('SIGTERM', () => stopAll(0));
process.on('SIGHUP', () => stopAll(0));
process.on('exit', () => {
  for (const { child } of services) signalGroup(child, 'SIGTERM');
});

async function main() {
  if (!existsSync(path.join(serverDir, 'src', 'main.ts'))) fail('packages/server/src/main.ts does not exist yet.');
  const tsx = binary(serverDir, 'tsx');
  const vite = binary(webDir, 'vite');

  if (!(await portIsFree(BACKEND_PORT, '127.0.0.1'))) {
    fail(`port ${BACKEND_PORT} is in use (another \`pnpm dev\` or backend running?).`);
  }
  if (!(await portIsFree(WEB_PORT, 'localhost'))) fail(`port ${WEB_PORT} is in use (another Vite dev server?).`);

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const childColor = color ? { FORCE_COLOR: '1' } : {};
  const nodeOptions = [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' ');

  console.log(dim(`data: ${dataDir}`));
  start('server', cyan, tsx, ['watch', '--clear-screen=false', 'src/main.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      ...childColor,
      NODE_ENV: 'development',
      NODE_OPTIONS: nodeOptions,
      IPHONE_AI_PORT: String(BACKEND_PORT),
      IPHONE_AI_HOST: '127.0.0.1',
      IPHONE_AI_DATA_DIR: dataDir,
      IPHONE_AI_DESKTOP_TOKEN: token,
    },
    onLine: onBackendLine,
  });
  start('web', magenta, vite, ['--port', String(WEB_PORT), '--strictPort'], {
    cwd: webDir,
    env: { ...process.env, ...childColor },
  });
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
