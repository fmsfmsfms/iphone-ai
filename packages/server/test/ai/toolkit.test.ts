// AgentToolkit with a fake device: how device-lane refusals reach the model.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActionResult, DeviceAction, ScreenDescription } from '@iphone-ai/shared';

import { AgentToolkit, type ToolkitTask } from '../../src/ai/agent/toolkit.js';
import { ScreenshotStore } from '../../src/ai/screenshots.js';
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

function screen(): ScreenDescription {
  return {
    capturedAt: Date.now(),
    elements: [{ id: 'e1', label: 'General', x: 112, y: 220, kind: 'text' }],
    rawText: '',
    imageBase64: null,
    imageMimeType: null,
    geometry: makeGeometry(410, 898, 'portrait'),
    fingerprint: 'fp',
  };
}

function toolkit(perform: (action: DeviceAction, context: ActionContext) => Promise<ActionResult>, screens: (() => ScreenDescription)[] = []) {
  const controller = new AbortController();
  let describes = 0;
  const device = {
    describe: async () => (screens[Math.min(describes++, screens.length - 1)] ?? screen)(),
    perform,
    geometry: makeGeometry(410, 898, 'portrait'),
    isStopLatched: false,
    getLatestFrame: () => null,
  } as unknown as DeviceController;
  const task: ToolkitTask = {
    taskId: 'task_1',
    leaseId: 'lease_1',
    signal: controller.signal,
    vision: false,
    maxActions: 5,
    mode: 'supervised',
    addStep: () => undefined,
    setActivity: () => undefined,
    setAwaitingApproval: () => undefined,
    waitIfPaused: async () => undefined,
    onActionsUsed: () => undefined,
  };
  const approvals = new ApprovalBroker(ctx.db, ctx.hub, ctx.activity);
  const kit = new AgentToolkit(
    {
      device,
      approvals,
      settings: ctx.settings,
      activity: ctx.activity,
      screenshots: new ScreenshotStore(ctx.db, ctx.paths, ctx.settings),
    },
    task,
  );
  return { kit, signal: controller.signal, approvals };
}

const tap = { id: 'c1', name: 'tap', args: { element_id: 'e1', reason: 'open General' } };

describe('AgentToolkit and the device lane', () => {
  it("passes the task's abort signal with every device action", async () => {
    const seen: ActionContext[] = [];
    const { kit, signal } = toolkit(async (_action, context) => {
      seen.push(context);
      return { ok: true, tool: 'tap', durationMs: 1, message: 'Tapped', focusChanged: true };
    });
    await kit.observe();
    const out = await kit.execute(tap);
    expect(out.isError).toBe(false);
    expect(seen[0]!.signal).toBe(signal);
  });

  it('reports a paused lease as "not executed" to the model instead of stopping the task', async () => {
    const { kit } = toolkit(async () => {
      throw new DeviceError('The task was paused before this action ran; it was not executed.', 'lease_paused');
    });
    await kit.observe();
    const out = await kit.execute(tap);
    expect(out.isError).toBe(true);
    expect(out.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('NOT executed') });
    expect(kit.actionCount).toBe(0);
    // The task keeps going: the next tool call works.
    const next = await kit.execute({ id: 'c2', name: 'observe_screen', args: {} });
    expect(next.isError).toBe(false);
  });

  describe('after an approval wait (Assisted mode)', () => {
    const timer = (time: string, extra: { label: string; x: number; y: number }[] = []) => (): ScreenDescription => {
      const elements = [
        { id: 'e1', label: 'Stopwatch', x: 205, y: 70, kind: 'text' },
        { id: 'e2', label: time, x: 205, y: 300, kind: 'text' },
        { id: 'e3', label: 'Lap', x: 100, y: 600, kind: 'text' },
        ...extra.map((e, i) => ({ id: `e${i + 4}`, kind: 'text', ...e })),
      ];
      return { ...screen(), elements, fingerprint: elements.map((e) => e.label).join('|') };
    };

    async function approvedKey(screens: (() => ScreenDescription)[]) {
      ctx.settings.update({ permissions: { controlMode: 'assisted' } });
      const performed: DeviceAction[] = [];
      const { kit, approvals } = toolkit(async (action) => {
        performed.push(action);
        return { ok: true, tool: 'press_key', durationMs: 1, message: 'Pressed', focusChanged: true };
      }, screens);
      await kit.observe();
      const running = kit.execute({ id: 'k', name: 'press_key', args: { key: 'space', reason: 'start' } });
      for (let i = 0; i < 100 && approvals.listPending().length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      approvals.decide(approvals.listPending()[0]!.id, 'approved', 'user');
      return { out: await running, performed };
    }

    it('ignores numbers that tick on their own', async () => {
      const { out, performed } = await approvedKey([timer('0:35.10'), timer('0:41.72')]);
      expect(performed.length).toBe(1);
      expect(out.content[0]).toMatchObject({ text: expect.stringContaining('Action: Press space') });
    });

    it('refuses when new text (e.g. a dialog) appeared', async () => {
      const { out, performed } = await approvedKey([timer('0:35.10'), timer('0:35.10', [{ label: 'Delete Lap?', x: 205, y: 420 }])]);
      expect(performed).toEqual([]);
      expect(out.isError).toBe(true);
      expect(out.content[0]).toMatchObject({ text: expect.stringContaining('“delete lap?”') });
    });
  });
});
