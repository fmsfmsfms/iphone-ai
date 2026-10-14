// Test helpers for live capture: the FAKE capture helper (a Node script that
// speaks the exact helper protocol — no ScreenCaptureKit, no window, no
// phone), protocol encoders and a fake device status.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeviceStatus, MirroringState, WindowGeometry } from '@iphone-ai/shared';

import type { CaptureHelperCommand, HelperFrameHeader, HelperStatus, LiveCaptureDevice } from '../../src/device/live-capture.js';
import { makeGeometry } from '../../src/mcp/parsers.js';

export const FAKE_HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fake-capture-helper.mjs');

export interface FakeScenario {
  mode?: 'frames' | 'permission' | 'waiting' | 'garbage' | 'silent';
  ptW?: number;
  ptH?: number;
  pxW?: number;
  pxH?: number;
  frames?: number;
  crashAfterFrames?: number;
  chunkBytes?: number;
  jpegBytes?: number;
  startDelayMs?: number;
}

export interface FakeHelperLogEntry {
  t: number;
  pid: number;
  event: 'start' | 'stdin' | 'stdin-eof' | 'signal' | 'exit' | 'crash';
  argv?: string[];
  line?: string;
  code?: number;
  reason?: string;
  signal?: string;
}

export interface FakeHelper {
  command: CaptureHelperCommand;
  /** Scenario for the NEXT spawn (the fake reads it once at start). */
  setScenario(scenario: FakeScenario): void;
  log(): FakeHelperLogEntry[];
  starts(): FakeHelperLogEntry[];
  stdinLines(): string[];
}

export function fakeHelper(dir: string, scenario: FakeScenario = {}): FakeHelper {
  const scenarioFile = path.join(dir, `fake-helper-scenario-${Math.random().toString(36).slice(2)}.json`);
  const logFile = `${scenarioFile}.log.jsonl`;
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const log = (): FakeHelperLogEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as FakeHelperLogEntry)
      : [];
  return {
    command: { command: process.execPath, args: [FAKE_HELPER, '--scenario', scenarioFile, '--log', logFile] },
    setScenario(next) {
      writeFileSync(scenarioFile, JSON.stringify(next));
    },
    log,
    starts: () => log().filter((e) => e.event === 'start'),
    stdinLines: () => log().filter((e) => e.event === 'stdin').map((e) => e.line ?? ''),
  };
}

/** Mutable device status for LiveCapture (only what it reads). */
export class FakeLiveDevice implements LiveCaptureDevice {
  screenRecording: 'granted' | 'denied' | 'unknown' = 'granted';
  mirroringState: MirroringState = 'connected';
  controlOwner: DeviceStatus['controlOwner'] = 'none';
  geometry: WindowGeometry | null = makeGeometry(410, 898, 'portrait');
  seq = 0;

  nextFrameSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  getStatus(): DeviceStatus {
    return {
      server: {
        state: 'ready',
        binaryPath: '/opt/homebrew/bin/mirroir',
        pid: 1,
        version: 'test',
        protocolVersion: null,
        startedAt: 1,
        restartCount: 0,
        lastError: null,
        tools: [],
        permissionFile: null,
      },
      mirroring: { state: this.mirroringState, rawStatus: '', target: 'iphone', geometry: this.geometry, checkedAt: 1 },
      permissions: { screenRecording: this.screenRecording, accessibility: 'granted', source: 'test', checkedAt: 1 },
      controlOwner: this.controlOwner,
      stopLatched: false,
      stopReason: null,
      queueDepth: 0,
      actionInFlight: false,
      lastFocusSteal: null,
    };
  }
}

function envelope(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}

export function encodeHelperStatus(status: HelperStatus): Buffer {
  return envelope(0x01, Buffer.from(JSON.stringify(status), 'utf8'));
}

export function encodeHelperFrame(header: HelperFrameHeader, jpeg: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return envelope(0x02, Buffer.concat([length, json, jpeg]));
}

export function fakeJpeg(n: number, size = 32): Buffer {
  const body = Buffer.alloc(size, n % 251);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[size - 2] = 0xff;
  body[size - 1] = 0xd9;
  return body;
}
