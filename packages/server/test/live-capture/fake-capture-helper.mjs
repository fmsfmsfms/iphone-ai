#!/usr/bin/env node
// FAKE iphone-ai-capture helper for tests — no ScreenCaptureKit, no window,
// no phone. Speaks the exact helper protocol on stdout:
//   [u32 BE N = length of the rest][1 byte type][N-1 bytes payload]
//   0x01 STATUS  UTF-8 JSON {event, message?, code?, ptW?, ptH?, pxW?, pxH?}
//   0x02 FRAME   [u32 BE H][H bytes JSON {seq, ts, ptW, ptH, pxW, pxH}][JPEG-like bytes]
// stdin: JSON lines {"cmd":"config",...} / {"cmd":"stop"}; EOF or SIGTERM → exit 0.
//
// Usage: node fake-capture-helper.mjs --scenario <file.json> --log <file.jsonl> [standard helper flags]
// The scenario file is read once at start (tests rewrite it between spawns):
//   mode: 'frames' (default) | 'permission' | 'waiting' | 'garbage' | 'silent'
//   ptW, ptH, pxW, pxH: window/frame sizes (default 410×898 pt, 730×1600 px)
//   frames: stop emitting after this many frames (stays alive)
//   crashAfterFrames: exit(1) after this many frames
//   chunkBytes: write output in chunks of at most this many bytes (parser test)
//   jpegBytes: size of each fake JPEG (default 64)
//   startDelayMs: delay before "started"
// Every start, stdin line, signal and exit is appended to the log file.

import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

const logFile = flag('--log');
const scenarioFile = flag('--scenario');
const scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile, 'utf8')) : {};
let fps = Number(flag('--fps', '30'));

function log(entry) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`);
}

log({ event: 'start', argv });

const ptW = scenario.ptW ?? 410;
const ptH = scenario.ptH ?? 898;
const pxW = scenario.pxW ?? 730;
const pxH = scenario.pxH ?? 1600;

let closing = false;
function write(buffer) {
  if (closing) return;
  const chunk = scenario.chunkBytes;
  if (!chunk) {
    process.stdout.write(buffer);
    return;
  }
  for (let i = 0; i < buffer.length; i += chunk) process.stdout.write(buffer.subarray(i, i + chunk));
}

function message(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}

function status(event, extra = {}) {
  write(message(0x01, Buffer.from(JSON.stringify({ event, ...extra }), 'utf8')));
}

function fakeJpeg(seq) {
  const size = Math.max(8, scenario.jpegBytes ?? 64);
  const body = Buffer.alloc(size, seq % 251);
  body[0] = 0xff;
  body[1] = 0xd8;
  body.writeUInt32BE(seq >>> 0, 2);
  body[size - 2] = 0xff;
  body[size - 1] = 0xd9;
  return body;
}

let seq = 0;
function frame() {
  seq += 1;
  const header = Buffer.from(JSON.stringify({ seq, ts: Date.now(), ptW, ptH, pxW, pxH }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  write(message(0x02, Buffer.concat([len, header, fakeJpeg(seq)])));
}

let timer = null;
function exit(code, reason) {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  log({ event: 'exit', code, reason });
  const final = message(0x01, Buffer.from(JSON.stringify({ event: 'stopped', message: reason }), 'utf8'));
  process.stdout.write(final, () => process.exit(code));
  setTimeout(() => process.exit(code), 200).unref();
}

function startFrames() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (scenario.frames !== undefined && seq >= scenario.frames) return;
    frame();
    if (scenario.crashAfterFrames !== undefined && seq >= scenario.crashAfterFrames) {
      log({ event: 'crash', frames: seq });
      process.exit(1);
    }
  }, Math.max(5, Math.round(1000 / fps)));
}

process.on('SIGTERM', () => {
  log({ event: 'signal', signal: 'SIGTERM' });
  exit(0, 'SIGTERM');
});

let stdinRest = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text) => {
  stdinRest += text;
  const lines = stdinRest.split('\n');
  stdinRest = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    log({ event: 'stdin', line });
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.cmd === 'stop') exit(0, 'stop command');
    if (cmd.cmd === 'config' && typeof cmd.fps === 'number') {
      fps = cmd.fps;
      if (timer) startFrames();
    }
  }
});
process.stdin.on('end', () => {
  log({ event: 'stdin-eof' });
  exit(0, 'stdin EOF');
});

process.stderr.write(`fake capture helper ${process.pid} starting (${scenario.mode ?? 'frames'})\n`);

const mode = scenario.mode ?? 'frames';
setTimeout(() => {
  switch (mode) {
    case 'permission':
      status('error', { code: 'permission', message: 'The user declined TCCs for application, window, display capture' });
      setTimeout(() => {
        log({ event: 'exit', code: 2, reason: 'permission' });
        process.exit(2);
      }, 20);
      break;
    case 'waiting':
      status('waiting', { message: 'iPhone Mirroring window not found' });
      timer = setInterval(() => status('waiting', { message: 'iPhone Mirroring window not found' }), 1000);
      break;
    case 'garbage': {
      const bad = Buffer.alloc(5);
      bad.writeUInt32BE(0xffffffff, 0);
      write(bad);
      break;
    }
    case 'silent':
      status('started', { ptW, ptH, pxW, pxH });
      break;
    default:
      status('started', { ptW, ptH, pxW, pxH });
      startFrames();
  }
}, scenario.startDelayMs ?? 0);
