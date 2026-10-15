// The AI "swipe" tool: Mirroir's `swipe` (a trackpad scroll; Mirroir's `drag`
// is a pointer click-drag that iOS scroll views ignore). The default (long)
// pages with a one-screen flick that the device controller settles; short and
// medium are paced scrolls without a momentum tail. Optionally repeated
// (`times`) with one observation at the end. Fake device; no Mirroir, no phone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIRROIR_FLICK_SPEED_PT_PER_S, settleNudge, type ActionResult, type DeviceAction, type ScreenDescription } from '@iphone-ai/shared';

import { agentSystemPrompt } from '../../src/ai/agent/prompts.js';
import { AgentToolkit, SWIPE_MARGIN_X, SWIPE_MARGIN_Y, swipeAction, type ToolkitTask } from '../../src/ai/agent/toolkit.js';
import { ScreenshotStore } from '../../src/ai/screenshots.js';
import type { ModelContent } from '../../src/ai/types.js';
import { DeviceError, type ActionContext, type DeviceController } from '../../src/device/device-controller.js';
import { makeGeometry } from '../../src/mcp/parsers.js';
import { ApprovalBroker } from '../../src/policy/approvals.js';
import { createCoreContext, type CoreContext } from '../helpers/context.js';

let ctx: CoreContext;

beforeEach(() => {
  ctx = createCoreContext({ settings: { permissions: { controlMode: 'supervised' }, ai: { settleDelayMs: 100 } } });
});

afterEach(async () => {
  await ctx.cleanup();
});

function screen(fingerprint = 'feed'): ScreenDescription {
  return {
    capturedAt: Date.now(),
    elements: [{ id: 'e1', label: 'For You', x: 205, y: 80, kind: 'text' }],
    rawText: '',
    imageBase64: null,
    imageMimeType: null,
    geometry: makeGeometry(410, 898, 'portrait'),
    fingerprint,
  };
}

interface Kit {
  kit: AgentToolkit;
  approvals: ApprovalBroker;
  performed: { action: DeviceAction; ctx: ActionContext; at: number }[];
  describes: () => number;
}

function makeKit(
  options: {
    maxActions?: number;
    perform?: (action: DeviceAction, context: ActionContext, n: number) => Promise<ActionResult> | ActionResult;
    screens?: (n: number) => ScreenDescription;
  } = {},
): Kit {
  const controller = new AbortController();
  let describes = 0;
  const performed: Kit['performed'] = [];
  const device = {
    describe: async () => (options.screens ?? (() => screen()))(describes++),
    perform: async (action: DeviceAction, context: ActionContext) => {
      performed.push({ action, ctx: context, at: Date.now() });
      if (options.perform) return options.perform(action, context, performed.length);
      return { ok: true, tool: 'swipe', durationMs: 300, message: 'Swiped from (205,629) to (205,269)', focusChanged: true };
    },
    geometry: makeGeometry(410, 898, 'portrait'),
    isStopLatched: false,
    getLatestFrame: () => null,
  } as unknown as DeviceController;
  const task: ToolkitTask = {
    taskId: 'task_1',
    leaseId: 'lease_1',
    signal: controller.signal,
    vision: false,
    maxActions: options.maxActions ?? 25,
    mode: ctx.settings.get().permissions.controlMode,
    addStep: () => undefined,
    setActivity: () => undefined,
    setAwaitingApproval: () => undefined,
    waitIfPaused: async () => undefined,
    onActionsUsed: () => undefined,
  };
  const approvals = new ApprovalBroker(ctx.db, ctx.hub, ctx.activity);
  const kit = new AgentToolkit(
    { device, approvals, settings: ctx.settings, activity: ctx.activity, screenshots: new ScreenshotStore(ctx.db, ctx.paths, ctx.settings) },
    task,
  );
  return { kit, approvals, performed, describes: () => describes };
}

const text = (out: { content: ModelContent[] }) =>
  out.content
    .filter((c): c is Extract<ModelContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('swipeAction (swipe geometry)', () => {
  it('scrolls short/medium (25/45%) at 460 pt/s and pages long with a settled one-screen flick (91%)', () => {
    expect(swipeAction('up', 'medium', 410, 898)).toEqual({ kind: 'swipe', fromX: 205, fromY: 651, toX: 205, toY: 247, durationMs: 879 });
    expect(swipeAction('up', 'short', 410, 898)).toEqual({ kind: 'swipe', fromX: 205, fromY: 561, toX: 205, toY: 337, durationMs: 487 });
    expect(swipeAction('up', 'long', 410, 898)).toEqual({ kind: 'swipe', fromX: 205, fromY: 858, toX: 205, toY: 40, durationMs: 300, settle: true });
    expect(swipeAction('down', 'medium', 410, 898)).toEqual({ kind: 'swipe', fromX: 205, fromY: 247, toX: 205, toY: 651, durationMs: 879 });
    expect(swipeAction('left', 'long', 410, 898)).toEqual({ kind: 'swipe', fromX: 392, fromY: 449, toX: 18, toY: 449, durationMs: 300, settle: true });
    expect(swipeAction('right', 'short', 410, 898)).toEqual({ kind: 'swipe', fromX: 154, fromY: 449, toX: 256, toY: 449, durationMs: 222 });
    // The iPhone 13 Mirroring window measured on the device (355×782 pt): 712 pt, the flick that moved TikTok one screen.
    expect(swipeAction('up', 'long', 355, 782)).toEqual({ kind: 'swipe', fromX: 178, fromY: 747, toX: 178, toY: 35, durationMs: 300, settle: true });
  });

  it('settles a page flick with a 20 pt nudge through the middle at 100 pt/s, in the same direction', () => {
    expect(settleNudge(swipeAction('up', 'long', 410, 898), 410, 898)).toEqual({ kind: 'swipe', fromX: 205, fromY: 459, toX: 205, toY: 439, durationMs: 200 });
    expect(settleNudge(swipeAction('left', 'long', 410, 898), 410, 898)).toEqual({ kind: 'swipe', fromX: 215, fromY: 449, toX: 195, toY: 449, durationMs: 200 });
    expect(settleNudge({ fromX: 10, fromY: 10, toX: 10, toY: 10 }, 410, 898)).toBeNull();
    expect(settleNudge(swipeAction('up', 'long', 410, 898), 0, 898)).toBeNull();
  });

  it('keeps short and medium scrolls under Mirroir’s flick speed (no momentum tail)', () => {
    for (const [w, h] of [
      [410, 898],
      [355, 782],
      [932, 430],
      [300, 180],
    ] as const) {
      for (const direction of ['up', 'down', 'left', 'right'] as const) {
        for (const distance of ['short', 'medium'] as const) {
          const a = swipeAction(direction, distance, w, h);
          expect(a.settle).toBeUndefined();
          const travel = Math.hypot(a.toX - a.fromX, a.toY - a.fromY);
          expect(travel / (a.durationMs / 1000)).toBeLessThan(MIRROIR_FLICK_SPEED_PT_PER_S);
          expect(a.durationMs).toBeGreaterThanOrEqual(60);
        }
      }
    }
  });

  it('keeps scrolls at least 60 pt from the top and bottom (clear of the sides) and page flicks inside the window', () => {
    const sizes: [number, number][] = [
      [410, 898],
      [430, 932],
      [320, 568],
      [868, 440],
      [932, 430],
      [300, 180],
    ];
    for (const [w, h] of sizes) {
      for (const direction of ['up', 'down', 'left', 'right'] as const) {
        for (const distance of ['short', 'medium', 'long'] as const) {
          const a = swipeAction(direction, distance, w, h);
          const marginY = distance === 'long' ? 1 : SWIPE_MARGIN_Y;
          const marginX = distance === 'long' ? 1 : SWIPE_MARGIN_X;
          for (const y of [a.fromY, a.toY]) {
            expect(y).toBeGreaterThanOrEqual(Math.min(marginY, h / 2));
            expect(y).toBeLessThanOrEqual(Math.max(h - marginY, h / 2));
          }
          for (const x of [a.fromX, a.toX]) {
            expect(x).toBeGreaterThanOrEqual(marginX);
            expect(x).toBeLessThanOrEqual(w - marginX);
          }
          // Still a movement in the requested direction.
          if (direction === 'up') expect(a.toY).toBeLessThan(a.fromY);
          if (direction === 'down') expect(a.toY).toBeGreaterThan(a.fromY);
          if (direction === 'left') expect(a.toX).toBeLessThan(a.fromX);
          if (direction === 'right') expect(a.toX).toBeGreaterThan(a.fromX);
        }
      }
    }
  });
});

describe('AI swipe tool', () => {
  it('swipes with Mirroir swipe (not a click-drag), governed by the "swipe" permission', async () => {
    // Default allowed AI tools include "swipe" but not "drag".
    expect(ctx.settings.get().permissions.aiAllowedTools).toContain('swipe');
    expect(ctx.settings.get().permissions.aiAllowedTools).not.toContain('drag');
    const k = makeKit();
    await k.kit.observe();
    const out = await k.kit.execute({ id: 's', name: 'swipe', args: { direction: 'up', reason: 'next video' } });
    expect(out.isError).toBe(false);
    expect(k.performed).toHaveLength(1);
    // Default distance: long (the settled page flick).
    expect(k.performed[0]!.action).toEqual({ kind: 'swipe', fromX: 205, fromY: 858, toX: 205, toY: 40, durationMs: 300, settle: true });
    expect(k.performed[0]!.ctx.decision.verdict).toBe('allow');
    expect(text(out)).toContain('Action: Swipe from (205, 858) to (205, 40)');
  });

  it('is not offered, and a swipe is refused, when "swipe" is not an allowed AI tool', async () => {
    ctx.settings.update({ permissions: { aiAllowedTools: ['tap', 'drag'] } });
    const k = makeKit();
    expect(k.kit.toolNames()).not.toContain('swipe');
    await k.kit.observe();
    const out = await k.kit.execute({ id: 's', name: 'swipe', args: { direction: 'up', reason: 'x' } });
    expect(out.isError).toBe(true);
    expect(k.performed).toHaveLength(0);
  });

  it('documents times and interval_ms in the tool schema and the system prompt', () => {
    const def = makeKit().kit.toolDefs().find((t) => t.name === 'swipe')!;
    const props = (def.parameters as { properties: Record<string, { minimum?: number; maximum?: number }> }).properties;
    expect(props.times).toMatchObject({ minimum: 1, maximum: 10 });
    expect(props.interval_ms).toMatchObject({ minimum: 300, maximum: 800 });
    expect(def.description).toMatch(/pages to the next item and returns once the feed has settled/);
    const prompt = agentSystemPrompt({ mode: 'supervised', maxActions: 25, vision: true, tools: ['swipe'] });
    expect(prompt).toMatch(/swipe pages or scrolls across the middle of the screen/);
    expect(prompt).toMatch(/The default distance \(long\) pages to the next item and has settled when it returns/);
    expect(prompt).toMatch(/times/);
  });

  it('repeats the swipe `times` times, interval_ms apart, with ONE observation at the end', async () => {
    const k = makeKit({ screens: (n) => screen(n === 0 ? 'video-1' : 'video-4') });
    await k.kit.observe();
    expect(k.describes()).toBe(1);
    const started = Date.now();
    const out = await k.kit.execute({ id: 's', name: 'swipe', args: { direction: 'up', times: 3, interval_ms: 300, reason: 'skip three videos' } });
    expect(out.isError).toBe(false);
    expect(k.performed).toHaveLength(3);
    expect(k.describes()).toBe(2);
    const gaps = k.performed.slice(1).map((p, i) => p.at - k.performed[i]!.at);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(290);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(k.kit.actionCount).toBe(3);
    const body = text(out);
    expect(body).toContain('Action: Swipe from (205, 858) to (205, 40) ×3');
    expect(body).toContain('Performed 3 swipes, 300 ms apart.');
    expect(body).toContain('Screen changed: yes');
    expect(body).toContain('Actions used: 3/25.');
  });

  it('stops repeating when the action budget runs out', async () => {
    const k = makeKit({ maxActions: 2 });
    await k.kit.observe();
    const out = await k.kit.execute({ id: 's', name: 'swipe', args: { direction: 'up', times: 5, interval_ms: 300, reason: 'page' } });
    expect(k.performed).toHaveLength(2);
    expect(text(out)).toContain('Performed 2 of 5 swipes (stopped: the action budget (2 actions) is used up).');
  });

  it('re-checks the policy before every repetition (switching to Observe Only stops the rest)', async () => {
    const k = makeKit({
      perform: (_action, _context, n) => {
        if (n === 1) ctx.settings.update({ permissions: { controlMode: 'observe' } });
        return { ok: true, tool: 'swipe', durationMs: 300, message: 'Swiped', focusChanged: true };
      },
    });
    await k.kit.observe();
    const out = await k.kit.execute({ id: 's', name: 'swipe', args: { direction: 'up', times: 3, interval_ms: 300, reason: 'page' } });
    expect(k.performed).toHaveLength(1);
    expect(text(out)).toMatch(/Performed 1 of 3 swipes \(stopped: blocked by iPhone AI's safety policy \(Observe Only mode/);
  });

  it('asks for ONE approval covering all repetitions in Assisted Control', async () => {
    ctx.settings.update({ permissions: { controlMode: 'assisted' } });
    const k = makeKit();
    await k.kit.observe();
    const running = k.kit.execute({ id: 's', name: 'swipe', args: { direction: 'up', times: 3, interval_ms: 300, reason: 'page' } });
    for (let i = 0; i < 100 && k.approvals.listPending().length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    const pending = k.approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.summary).toMatch(/Swipe .* — up \(long\) ×3/);
    expect(pending[0]!.action.args).toMatchObject({ times: 3, intervalMs: 300 });
    k.approvals.decide(pending[0]!.id, 'approved', 'user');
    const out = await running;
    expect(out.isError).toBe(false);
    expect(k.performed).toHaveLength(3);
    expect(new Set(k.performed.map((p) => p.ctx.approvalId)).size).toBe(1);
    expect(k.performed[0]!.ctx.approvalId).toBe(pending[0]!.id);
    expect(k.approvals.listPending()).toHaveLength(0);
  });

  it('counts a repeated swipe once for loop detection on an unchanged screen', async () => {
    const k = makeKit();
    await k.kit.observe();
    const args = { direction: 'up', times: 2, interval_ms: 300, reason: 'page' };
    expect((await k.kit.execute({ id: 'a', name: 'swipe', args })).isError).toBe(false);
    expect((await k.kit.execute({ id: 'b', name: 'swipe', args })).isError).toBe(false);
    const third = await k.kit.execute({ id: 'c', name: 'swipe', args });
    expect(third.isError).toBe(true);
    expect(text(third)).toMatch(/Loop detected/);
    expect(k.performed).toHaveLength(4);
  });

  it('reports the swipes that ran when a later one fails, with a fresh observation', async () => {
    const k = makeKit({
      perform: (_action, _context, n) => {
        if (n === 2) throw new DeviceError('iPhone Mirroring is not connected (No window).', 'not_connected');
        return { ok: true, tool: 'swipe', durationMs: 300, message: 'Swiped', focusChanged: true };
      },
    });
    await k.kit.observe();
    const out = await k.kit.execute({ id: 's', name: 'swipe', args: { direction: 'up', times: 3, interval_ms: 300, reason: 'page' } });
    expect(k.performed).toHaveLength(2);
    expect(k.kit.actionCount).toBe(1);
    expect(k.describes()).toBe(2);
    expect(text(out)).toContain('Performed 1 of 3 swipes (stopped: iPhone Mirroring is not connected (No window).).');
  });
});
