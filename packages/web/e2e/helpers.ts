// Helpers shared by the E2E specs: signing in, talking to the backend API with
// the page's session, steering the MOCK Mirroir server (mock-state.json) and
// reading what it received (mock-calls.jsonl), scripting the fake model, and
// mapping phone points onto the live viewer.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { AgentTask, AppSettings, ApprovalRequest, ControlMode, DeviceStatus, ProviderConfig, ScreenElement, WindowGeometry, WorkflowRun } from '@iphone-ai/shared';

import { DESKTOP_TOKEN, readRunState, type RunState } from './support/env';

export { DESKTOP_TOKEN } from './support/env';

let cachedState: RunState | null = null;
export function runState(): RunState {
  cachedState ??= readRunState();
  return cachedState;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────── mock Mirroir ───────────────────────────

/** Contents of <workspace>/mock-state.json (see packages/server/test/mock-mirroir/README.md). */
export interface MockState {
  mirroring?: 'connected' | 'paused' | 'not_running' | 'no_window';
  window?: string;
  pos?: string;
  scale?: number;
  screen?: string;
  resetSeq?: number;
  crashOnCall?: string;
  slowMs?: Record<string, number>;
  screenRecording?: 'granted' | 'denied';
  ocrFailure?: boolean;
  resumeDelayMs?: number;
  timeScale?: number;
}

export interface MockCall {
  t: number;
  name: string;
  args: Record<string, unknown>;
}

export interface MockLogEntry {
  t: number;
  name?: string;
  args?: Record<string, unknown>;
  event?: string;
  signal?: string;
  pid?: number;
}

function workspaceFile(name: string): string {
  return path.join(runState().workspace, name);
}

export function readMockState(): MockState {
  const file = workspaceFile('mock-state.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as MockState;
}

/** Merges `patch` into mock-state.json (atomically; the mock re-reads it on every tool call). */
export function writeMockState(patch: MockState, options: { replace?: boolean } = {}): void {
  const file = workspaceFile('mock-state.json');
  const next = options.replace ? patch : { ...readMockState(), ...patch };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, file);
}

/** Every line of mock-calls.jsonl: tool calls plus lifecycle lines ({event}, {signal}). */
export function readMockLog(): MockLogEntry[] {
  const file = workspaceFile('mock-calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MockLogEntry);
}

/** Every tools/call the mock received, in order. */
export function readCalls(): MockCall[] {
  return readMockLog()
    .filter((e): e is MockLogEntry & { name: string } => typeof e.name === 'string')
    .map((e) => ({ t: e.t, name: e.name, args: e.args ?? {} }));
}

/** Input tools only (what could have touched a real phone). */
export const INPUT_TOOLS = new Set([
  'tap',
  'double_tap',
  'long_press',
  'swipe',
  'drag',
  'type_text',
  'press_key',
  'press_home',
  'press_back',
  'press_app_switcher',
  'spotlight',
  'launch_app',
  'scroll_to',
  'touch',
]);

export function callsSince(mark: number, name?: string): MockCall[] {
  return readCalls()
    .slice(mark)
    .filter((c) => (name ? c.name === name : true));
}

export function mockStarts(): number {
  return readMockLog().filter((e) => e.event === 'start').length;
}

/** Polls mock-calls.jsonl until a call matches. */
export async function waitForCall(predicate: (call: MockCall) => boolean, options: { since?: number; timeout?: number; message?: string } = {}): Promise<MockCall> {
  const deadline = Date.now() + (options.timeout ?? 15_000);
  for (;;) {
    const hit = readCalls()
      .slice(options.since ?? 0)
      .find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(options.message ?? 'The mock Mirroir server never received the expected call.');
    await sleep(100);
  }
}

// ─────────────────────────── fake model ───────────────────────────

export type ScriptedTurn =
  | { text: string; delayMs?: number }
  | { text?: string; tool: string; args?: Record<string, unknown>; delayMs?: number }
  | { text?: string; tools: { name: string; args?: Record<string, unknown> }[]; delayMs?: number };

/** Replaces the fake model's queue of replies (and clears its request log). */
export async function scriptModel(turns: ScriptedTurn[]): Promise<void> {
  const res = await fetch(`${runState().modelURL}/__script`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turns }),
  });
  if (!res.ok) throw new Error(`Scripting the fake model failed: HTTP ${res.status}`);
}

export interface ModelRequestLog {
  requests: { tools: string[]; reply: { text: string; calls: { name: string; arguments: string }[] }; problems: string[] }[];
  queued: number;
}

export async function modelRequests(): Promise<ModelRequestLog> {
  const res = await fetch(`${runState().modelURL}/__requests`);
  return (await res.json()) as ModelRequestLog;
}

// ─────────────────────────── backend API ───────────────────────────

const CSRF = { 'x-iphone-ai': '1' };

/** Raw API call with the page's session cookie (state-changing calls carry the CSRF header). */
export async function apiFetch(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', urlPath: string, body?: unknown): Promise<APIResponse> {
  return page.request.fetch(urlPath, {
    method,
    headers: method === 'GET' ? {} : CSRF,
    ...(body !== undefined ? { data: body } : method === 'GET' ? {} : { data: {} }),
    failOnStatusCode: false,
  });
}

export async function api<T>(page: Page, method: 'GET' | 'POST' | 'PUT' | 'DELETE', urlPath: string, body?: unknown): Promise<T> {
  const res = await apiFetch(page, method, urlPath, body);
  if (!res.ok()) throw new Error(`${method} ${urlPath} → HTTP ${res.status()}: ${await res.text()}`);
  if (res.status() === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getStatus = (page: Page) => api<DeviceStatus>(page, 'GET', '/api/status');
export const getSettings = (page: Page) => api<AppSettings>(page, 'GET', '/api/settings');

interface Bootstrap {
  status: DeviceStatus;
  settings: AppSettings;
  pendingApprovals: ApprovalRequest[];
  activeTask: AgentTask | null;
  activeRun: WorkflowRun | null;
}
export const getBootstrap = (page: Page) => api<Bootstrap>(page, 'GET', '/api/bootstrap');

export interface DescribeResult {
  elements: ScreenElement[];
  rawText: string;
  fingerprint: string;
  geometry: WindowGeometry | null;
}
export const describeScreen = (page: Page) => api<DescribeResult>(page, 'POST', '/api/screen/describe', {});

export function findElement(described: DescribeResult, label: string): ScreenElement {
  const element = described.elements.find((e) => e.label === label);
  if (!element) throw new Error(`"${label}" is not on the mock screen:\n${described.rawText}`);
  return element;
}

const inputEnabled = (s: AppSettings) => s.permissions.manualControlEnabled || s.permissions.controlMode !== 'observe';

/**
 * Waits until Mirroir (mock) is ready, mirroring is connected and the device
 * lane is idle — and stays so for a moment (a settings change restarts
 * Mirroir asynchronously). `minStarts`: wait for that many mock start lines.
 */
export async function waitForDeviceReady(page: Page, options: { minStarts?: number; timeout?: number } = {}): Promise<DeviceStatus> {
  const deadline = Date.now() + (options.timeout ?? 30_000);
  let stable = 0;
  let refreshed = false;
  for (;;) {
    const status = await getStatus(page);
    const started = options.minStarts === undefined || mockStarts() >= options.minStarts;
    const ok =
      started &&
      status.server.state === 'ready' &&
      status.mirroring.state === 'connected' &&
      !status.actionInFlight &&
      status.queueDepth === 0;
    stable = ok ? stable + 1 : 0;
    if (stable >= 3) return status;
    if (started && status.server.state === 'ready' && status.mirroring.state !== 'connected' && !refreshed) {
      // Re-read Mirroir's status now instead of waiting for the 2 s poll.
      refreshed = true;
      await apiFetch(page, 'POST', '/api/connection/refresh', {});
    }
    if (Date.now() > deadline) {
      throw new Error(`The mock device did not become ready: server=${status.server.state} mirroring=${status.mirroring.state} inFlight=${status.actionInFlight}`);
    }
    await sleep(250);
  }
}

/**
 * Sets the control mode and/or manual control through the API, then waits for
 * the Mirroir restart that a change of its permission file causes.
 */
export async function setControl(page: Page, next: { mode?: ControlMode; manual?: boolean }): Promise<void> {
  const before = await getSettings(page);
  const starts = mockStarts();
  let after = before;
  if (next.mode !== undefined && before.permissions.controlMode !== next.mode) {
    after = await api<AppSettings>(page, 'PUT', '/api/control/mode', { mode: next.mode });
  }
  if (next.manual !== undefined && after.permissions.manualControlEnabled !== next.manual) {
    after = await api<AppSettings>(page, 'PUT', '/api/control/manual', { enabled: next.manual });
  }
  await waitForDeviceReady(page, inputEnabled(before) !== inputEnabled(after) ? { minStarts: starts + 1 } : {});
}

/** Waits for the Mirroir restart a UI-made mode/manual change caused (call with mockStarts() taken before). */
export async function waitForRestartAfter(page: Page, startsBefore: number): Promise<void> {
  await waitForDeviceReady(page, { minStarts: startsBefore + 1 });
}

/** Points the built-in "LM Studio (local)" provider at the fake model server and makes it active. */
export async function useFakeModel(page: Page): Promise<void> {
  const providers = await api<ProviderConfig[]>(page, 'GET', '/api/providers');
  const lmstudio = providers.find((p) => p.id === 'lmstudio');
  if (!lmstudio) throw new Error('The built-in lmstudio provider is missing.');
  await api(page, 'PUT', '/api/providers/lmstudio', {
    ...lmstudio,
    baseUrl: `${runState().modelURL}/v1`,
    model: 'scripted',
    vision: false,
    enabled: true,
    timeoutMs: 30_000,
  });
  await api(page, 'PUT', '/api/providers/active', { providerId: 'lmstudio' });
}

/**
 * Brings the backend and the simulated phone back to a known state: no task,
 * run or approval pending, STOP released, Observe Only, manual control off,
 * English, phone connected and on the Home Screen, empty model script.
 */
export async function resetState(page: Page): Promise<void> {
  await scriptModel([]);
  writeMockState({ timeScale: 0, mirroring: 'connected', screen: 'home', resetSeq: Date.now() }, { replace: true });

  let boot = await getBootstrap(page);
  if (boot.activeTask || boot.activeRun || boot.pendingApprovals.length > 0) {
    await api(page, 'POST', '/api/control/stop', { reason: 'E2E reset' });
    const deadline = Date.now() + 15_000;
    while ((boot.activeTask || boot.activeRun) && Date.now() < deadline) {
      await sleep(200);
      boot = await getBootstrap(page);
    }
  }
  if (boot.status.stopLatched || (await getStatus(page)).stopLatched) await api(page, 'POST', '/api/control/rearm', {});
  if (boot.settings.general.language !== 'en') await api(page, 'PUT', '/api/settings', { general: { language: 'en' } });
  if (boot.settings.permissions.approvalTimeoutSec !== 120) await api(page, 'PUT', '/api/settings', { permissions: { approvalTimeoutSec: 120 } });
  await setControl(page, { mode: 'observe', manual: false });

  // The default 410×898 pt window (a test may have resized it): wait until the backend has re-read it.
  let refreshed = false;
  await expect
    .poll(
      async () => {
        const geometryId = (await getStatus(page)).mirroring.geometry?.geometryId ?? null;
        if (geometryId !== '410x898' && !refreshed) {
          refreshed = true;
          await apiFetch(page, 'POST', '/api/connection/refresh', {});
        }
        return geometryId;
      },
      { timeout: 15_000, message: 'default window geometry' },
    )
    .toBe('410x898');

  // Applies the Home Screen directive (any tool call does) and checks it.
  await expect
    .poll(async () => (await describeScreen(page)).elements.map((e) => e.label), { timeout: 15_000, message: 'phone back on the Home Screen' })
    .toEqual(expect.arrayContaining(['Settings', 'Wallet', 'Safari']));
}

// ─────────────────────────── UI ───────────────────────────

/** Signs in like the desktop window does (per-launch token → session cookie → redirect to /). */
export async function login(page: Page): Promise<void> {
  await page.goto(`/auth/desktop?token=${DESKTOP_TOKEN}`);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Navigates within the single-page app (hash routes). */
export async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

export function statusBar(page: Page): Locator {
  return page.getByRole('banner', { name: 'Status' });
}

/** The front <img> of the phone viewer (the back buffer has no alt text). */
export function viewerImage(page: Page): Locator {
  return page.getByRole('img', { name: 'Screenshot of your iPhone screen' });
}

export async function frameNaturalSize(page: Page): Promise<{ width: number; height: number }> {
  return viewerImage(page).evaluate((img: HTMLImageElement) => ({ width: img.naturalWidth, height: img.naturalHeight }));
}

/** Client (CSS px) position of a window point on the displayed screenshot (object-fit: contain). */
export async function viewerPointFor(page: Page, point: { x: number; y: number }, windowWidthPt: number): Promise<{ x: number; y: number }> {
  const box = await viewerImage(page).evaluate((img: HTMLImageElement) => {
    const r = img.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, nw: img.naturalWidth, nh: img.naturalHeight };
  });
  const scale = Math.min(box.width / box.nw, box.height / box.nh);
  const offX = (box.width - box.nw * scale) / 2;
  const offY = (box.height - box.nh * scale) / 2;
  const pxPerPt = box.nw / windowWidthPt;
  return { x: box.left + offX + point.x * pxPerPt * scale, y: box.top + offY + point.y * pxPerPt * scale };
}

/** The src of the frame currently shown (an object URL that changes with every new frame). */
export async function viewerSrc(page: Page): Promise<string> {
  return (await viewerImage(page).getAttribute('src')) ?? '';
}

/** Switches the control mode from the status bar, confirming the escalation dialog. */
export async function switchModeInUi(page: Page, mode: 'Assisted' | 'AI Mode'): Promise<void> {
  await statusBar(page).getByRole('button', { name: /^Control mode:/ }).click();
  // (The dashboard's onboarding card has its own inline copy of the same menu.)
  await page.getByRole('dialog', { name: /^Control mode:/ }).getByRole('menuitemradio', { name: new RegExp(`^${mode}`) }).click();
  const dialog = page.getByRole('alertdialog', { name: `Switch to ${mode}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: `Switch to ${mode}` }).click();
  await expect(dialog).toBeHidden();
  await expect(statusBar(page).getByRole('button', { name: `Control mode: ${mode}` })).toBeVisible();
}
