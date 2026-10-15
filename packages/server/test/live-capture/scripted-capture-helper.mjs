#!/usr/bin/env node
// FAKE iphone-ai-capture helper for tests that need extra STATUS events at set
// times — no ScreenCaptureKit, no window, no phone. Like fake-capture-helper.mjs
// it sends "started" and then frames at --fps, and it also plays a script of
// status events, e.g. a second "started" (the real helper restarts its capture
// when the window id changes or a capture failed) or a "window" (a resize).
//
// Usage: node scripted-capture-helper.mjs --scenario <file.json> --log <file.jsonl> [standard helper flags]
// Scenario: { script: [{ atMs, event, ...fields }] } — atMs counts from the start.
// A scripted "waiting" holds frames back until the next scripted "started".
// The log file gets {event: 'start'|'step'|'stdin'|'exit'} lines; a step is
// logged once its status message was handed to stdout.

import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

const logFile = flag('--log');
const scenarioFile = flag('--scenario');
const scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile, 'utf8')) : {};
const fps = Number(flag('--fps', '10'));

function log(entry) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`);
}

log({ event: 'start', argv });

const ptW = 410;
const ptH = 898;
const pxW = 730;
const pxH = 1600;

let closing = false;
function message(type, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}

function status(event, extra = {}, done = undefined) {
  if (closing) return;
  process.stdout.write(message(0x01, Buffer.from(JSON.stringify({ event, ...extra }), 'utf8')), done);
}

let seq = 0;
function frame() {
  if (closing) return;
  seq += 1;
  const header = Buffer.from(JSON.stringify({ seq, ts: Date.now(), ptW, ptH, pxW, pxH }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  const jpeg = Buffer.alloc(32, seq % 251);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[30] = 0xff;
  jpeg[31] = 0xd9;
  process.stdout.write(message(0x02, Buffer.concat([len, header, jpeg])));
}

function exit(reason) {
  if (closing) return;
  closing = true;
  log({ event: 'exit', code: 0, reason });
  process.exit(0);
}

process.on('SIGTERM', () => exit('SIGTERM'));
let stdinRest = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (text) => {
  stdinRest += text;
  const lines = stdinRest.split('\n');
  stdinRest = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    log({ event: 'stdin', line });
    if (line.includes('"stop"')) exit('stop command');
  }
});
process.stdin.on('end', () => exit('stdin EOF'));

status('started', { ptW, ptH, pxW, pxH });
let waiting = false;
setInterval(() => {
  if (!waiting) frame();
}, Math.max(5, Math.round(1000 / fps)));
for (const step of scenario.script ?? []) {
  setTimeout(() => {
    const { atMs, event, ...fields } = step;
    waiting = event === 'waiting';
    status(event, fields, () => log({ event: 'step', step: event, atMs }));
  }, step.atMs);
}
