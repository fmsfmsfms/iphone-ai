// The re-check after an approval, driven through the real AgentToolkit: the
// fake screen changes while the approval card is open, and the approved action
// must NOT run unless only OCR noise changed. Cases are the v0.4.1 review's
// and the v0.5.0 verification's proofs (each ran the approved action then);
// coordinates follow the real
// 356×785 iPhone Mirroring window (status bar at y≈63, bottom button y≈700).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActionResult, DeviceAction, ScreenDescription, ScreenElement } from '@iphone-ai/shared';

import { AgentToolkit } from '../../src/ai/agent/toolkit.js';
import { ScreenshotStore } from '../../src/ai/screenshots.js';
import type { DeviceController } from '../../src/device/device-controller.js';
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

type E = [label: string, x: number, y: number];
let fp = 0;
/** A screen of text elements e1…, then unlabeled icons. */
function screen(elements: E[], icons: [number, number][] = []): () => ScreenDescription {
  const fingerprint = `fp${++fp}`;
  return () => ({
    capturedAt: Date.now(),
    elements: [
      ...elements.map(([label, x, y], i): ScreenElement => ({ id: `e${i + 1}`, label, x, y, kind: 'text' })),
      ...icons.map(([x, y], i): ScreenElement => ({ id: `e${elements.length + i + 1}`, label: '', x, y, kind: 'icon ~24pt' })),
    ],
    rawText: '',
    imageBase64: null,
    imageMimeType: null,
    geometry: makeGeometry(356, 785, 'portrait'),
    fingerprint,
  });
}

/**
 * Observes `screens[0]`, calls the tool, approves the card if one is shown, and
 * serves `screens[1]` (and later) to the re-check and after.
 */
async function approveThenChange(
  call: { name: string; args: Record<string, unknown> },
  screens: (() => ScreenDescription)[],
  opts: { typing?: boolean; mode?: 'supervised' | 'assisted' } = {},
) {
  ctx.settings.update({ permissions: { controlMode: opts.mode ?? 'supervised' } });
  const performed: DeviceAction[] = [];
  let describes = 0;
  const device = {
    describe: async () => screens[Math.min(describes++, screens.length - 1)]!(),
    perform: async (action: DeviceAction): Promise<ActionResult> => {
      performed.push(action);
      return { ok: true, tool: action.kind, durationMs: 1, message: 'ok', focusChanged: true };
    },
    geometry: makeGeometry(356, 785, 'portrait'),
    isStopLatched: false,
    getLatestFrame: () => null,
  } as unknown as DeviceController;
  const approvals = new ApprovalBroker(ctx.db, ctx.hub, ctx.activity);
  const kit = new AgentToolkit(
    { device, approvals, settings: ctx.settings, activity: ctx.activity, screenshots: new ScreenshotStore(ctx.db, ctx.paths, ctx.settings) },
    {
      taskId: 'task_1',
      leaseId: 'lease_1',
      signal: new AbortController().signal,
      vision: false,
      maxActions: 5,
      mode: opts.mode ?? 'supervised',
      addStep: () => undefined,
      setActivity: () => undefined,
      setAwaitingApproval: () => undefined,
      waitIfPaused: async () => undefined,
      onActionsUsed: () => undefined,
      uncommittedTyping: () => opts.typing ?? false,
    },
  );
  await kit.observe();
  const running = kit.execute({ id: 'c', name: call.name, args: { reason: 'test', ...call.args } });
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  running.then(markSettled, markSettled);
  let asked: { reasons: string[] } | null = null;
  for (let i = 0; i < 100 && !asked && !settled; i += 1) {
    const pending = approvals.listPending()[0];
    if (pending) {
      asked = { reasons: pending.reasons };
      approvals.decide(pending.id, 'approved', 'user');
    } else await new Promise((r) => setTimeout(r, 10));
  }
  const out = await running;
  const text = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { asked, performed, text };
}

const STATUS: E[] = [
  ['3:16 M', 72, 63],
  ['•ll 4G 60', 278, 63],
  ['67', 299, 63],
];
const ORDER: E[] = [['Your order', 178, 120], ['Big Mac Meal', 120, 300], ['Delivery fee', 120, 340], ['Promo code', 120, 420]];

describe('OCR noise alone does not cost a second approval', () => {
  it('runs an approved tap when only the clock and signal readings changed', async () => {
    const page: E[] = [["x McDonald's", 79, 105], ['Big Mac', 120, 300], ['Cheeseburger', 120, 380]];
    const before = screen([...STATUS, ...page]);
    const after = screen([['3:17 A', 72, 63], ['•Ill 4G 60', 278, 63], ['67', 299, 63], ...page]);
    const r = await approveThenChange({ name: 'tap', args: { x: 322, y: 200 } }, [before, after], { typing: true });
    expect(r.asked).not.toBeNull();
    expect(r.performed.map((a) => a.kind)).toEqual(['tap']);
  });

  it('runs an approved tap on a labelled element when only a re-read and the clock changed', async () => {
    const page: E[] = [['jai', 64, 151], ['Big Mac', 120, 300], ['Add', 300, 300]];
    const before = screen([...STATUS, ...page]);
    const after = screen([['3:171', 73, 63], ['•ll 4G 60', 278, 63], ['67', 299, 63], ['jaû', 64, 151], ...page.slice(1)]);
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e6' } }, [before, after], { mode: 'assisted' });
    expect(r.asked).not.toBeNull();
    expect(r.performed.map((a) => a.kind)).toEqual(['tap']);
  });

  it('runs an approved labelled tap when a relative time or a like count ticked', async () => {
    // "Share" and "Post" are sensitive (messaging), so Supervised asks first.
    const feed = (time: string): E[] => [...STATUS, ['ahmed_k', 90, 120], [time, 320, 120], ['Big Mac day', 150, 500], ['Share', 300, 700]];
    const share = await approveThenChange({ name: 'tap', args: { element_id: 'e7' } }, [screen(feed('5m')), screen(feed('6m'))]);
    expect(share.asked).not.toBeNull();
    expect(share.performed.map((a) => a.kind)).toEqual(['tap']);
    const comments = (likes: string): E[] => [...STATUS, [likes, 324, 468], ['Add comment...', 150, 700], ['Post', 320, 700]];
    const post = await approveThenChange({ name: 'tap', args: { element_id: 'e6' } }, [screen(comments('• 9.5K')), screen(comments('• 9.6K'))]);
    expect(post.asked).not.toBeNull();
    expect(post.performed.map((a) => a.kind)).toEqual(['tap']);
  });
});

describe('a changed screen refuses the approved action', () => {
  it('Return after typing, when the total changed from SAR 49.00 to SAR 149.00', async () => {
    const before = screen([...STATUS, ...ORDER, ['SAR 49.00', 280, 600]]);
    const after = screen([...STATUS, ...ORDER, ['SAR 149.00', 280, 600]]);
    const r = await approveThenChange({ name: 'press_key', args: { key: 'return' } }, [before, after], { typing: true });
    expect(r.asked).not.toBeNull();
    expect(r.performed).toEqual([]);
    expect(r.text).toContain('new text appeared (“sar 149.00”)');
  });

  it('Return after typing, when the masked card number changed (•••• 4321 → •••• 9876)', async () => {
    const pay: E[] = [...STATUS, ...ORDER, ['Pay with', 100, 500], ['Mada', 100, 540]];
    const before = screen([...pay, ['•••• 4321', 250, 540]]);
    const after = screen([...pay, ['•••• 9876', 250, 540]]);
    const r = await approveThenChange({ name: 'press_key', args: { key: 'return' } }, [before, after], { typing: true });
    expect(r.asked).not.toBeNull();
    expect(r.performed).toEqual([]);
    expect(r.text).toContain('new text appeared (“•••• 9876”)');
  });

  it('Return after typing, when the clock was misread and the total in the top band changed', async () => {
    // The re-check frame has no clock ("฿112"), so the total must not become the status-row anchor.
    const before = screen([...STATUS, ['49.00 SAR', 300, 88], ...ORDER]);
    const after = screen([['฿112', 64, 62], ['•ll 4G 60', 278, 63], ['99.00 SAR', 300, 88], ...ORDER]);
    const r = await approveThenChange({ name: 'press_key', args: { key: 'return' } }, [before, after], { typing: true });
    expect(r.performed).toEqual([]);
    expect(r.text).toContain('new text appeared (“99.00 sar”)');
  });

  it('Return after typing, when a decision word appeared on the status row beside the clock', async () => {
    for (const word of ['Pay', 'Allow', 'OK']) {
      const screens = [screen([...STATUS, ...ORDER]), screen([...STATUS, [word, 178, 66], ...ORDER])];
      const r = await approveThenChange({ name: 'press_key', args: { key: 'return' } }, screens, { typing: true });
      expect(r.performed, word).toEqual([]);
    }
  });

  it('Return after typing, when the recipient changed by one letter (To: Ahmed → To: Ahmad)', async () => {
    const before = screen([...STATUS, ['To: Ahmed', 120, 110], ['iMessage', 178, 600]]);
    const after = screen([...STATUS, ['To: Ahmad', 120, 110], ['iMessage', 178, 600]]);
    const r = await approveThenChange({ name: 'press_key', args: { key: 'return' } }, [before, after], { typing: true });
    expect(r.asked).not.toBeNull();
    expect(r.performed).toEqual([]);
    expect(r.text).toContain('new text appeared (“to: ahmad”)');
  });

  it('a labelled "Send" in another chat with the same bubbles and a one-letter header (Ahmed → Ahmad)', async () => {
    const before = screen([...STATUS, ['Ahmed', 178, 110], ['See you at 5', 250, 400], ['Send', 320, 700]]);
    const after = screen([...STATUS, ['Ahmad', 178, 110], ['See you at 5', 250, 400], ['Send', 320, 700]]);
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e6' } }, [before, after], { mode: 'assisted' });
    expect(r.asked).not.toBeNull();
    expect(r.performed).toEqual([]);
  });

  it('Return after typing, when a short alert ("Pay" / "OK" / "No") appeared over the screen', async () => {
    const base: E[] = [['Search the menu', 178, 104], ['Big Mac', 120, 300], ['Cheeseburger', 120, 380]];
    const before = screen([...STATUS, ...base]);
    const after = screen([...STATUS, ...base, ['Pay', 178, 380], ['OK', 120, 460], ['No', 240, 460]]);
    const r = await approveThenChange({ name: 'press_key', args: { key: 'return' } }, [before, after], { typing: true });
    expect(r.performed).toEqual([]);
    expect(r.text).toMatch(/NOT performed/);
  });

  it('a tap on an unlabeled arrow icon whose button was relabelled Next → Buy', async () => {
    const before = screen([...STATUS, ...ORDER, ['Next', 150, 700]], [[300, 700]]);
    const after = screen([...STATUS, ...ORDER, ['Buy', 150, 700]], [[300, 700]]);
    // 3 status + 4 order texts + the button label: the icon is e9.
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e9' } }, [before, after], { mode: 'assisted' });
    expect(r.asked).not.toBeNull();
    expect(r.performed).toEqual([]);
    expect(r.text).toMatch(/NOT performed/);
  });

  it('a coordinate tap at the same spot, whether the new word is "Buy" or "Pay"', async () => {
    for (const word of ['Buy', 'Pay']) {
      const before = screen([...STATUS, ...ORDER, ['Next', 150, 700]], [[300, 700]]);
      const after = screen([...STATUS, ...ORDER, [word, 150, 700]], [[300, 700]]);
      const r = await approveThenChange({ name: 'tap', args: { x: 300, y: 700 } }, [before, after], { mode: 'assisted' });
      expect(r.performed, word).toEqual([]);
      expect(r.text).toMatch(/NOT performed/);
    }
  });

  it('a tap at (322, 104) while a short notification banner ("Mom" / "OK") covers the top of the screen', async () => {
    const page: E[] = [["x McDonald's", 79, 105], ['Big Mac', 120, 300], ['Cheeseburger', 120, 380]];
    const before = screen([...STATUS, ...page]);
    const after = screen([...STATUS.slice(1), ['Mom', 90, 78], ['OK', 90, 96], ...page.slice(1)]);
    const r = await approveThenChange({ name: 'tap', args: { x: 322, y: 104 } }, [before, after], { typing: true });
    expect(r.asked).not.toBeNull();
    expect(r.performed).toEqual([]);
  });

  it('a tap on "Continue" when a different screen (the payment step) has "Continue" at the same spot', async () => {
    const before = screen([...STATUS, ['Delivery address', 178, 120], ['King Fahd Rd, Riyadh', 178, 200], ['Continue', 178, 700]]);
    const after = screen([...STATUS, ['Payment', 178, 120], ['Mada •••• 4321', 178, 200], ['Total SAR 1,249.00', 178, 600], ['Continue', 178, 700]]);
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e6' } }, [before, after], { mode: 'assisted' });
    expect(r.asked).not.toBeNull();
    expect(r.performed).toEqual([]);
    expect(r.text).toMatch(/The screen changed while waiting for approval \(new text appeared/);
  });

  it('a coordinate tap near "Continue" in the same situation', async () => {
    const before = screen([...STATUS, ['Delivery address', 178, 120], ['Continue', 178, 700]]);
    const after = screen([...STATUS, ['Payment', 178, 120], ['Total SAR 1,249.00', 178, 600], ['Continue', 178, 700]]);
    const r = await approveThenChange({ name: 'tap', args: { x: 178, y: 705 } }, [before, after], { mode: 'assisted' });
    expect(r.performed).toEqual([]);
  });

  it('an element target whose label changed at the same spot (Add → Buy)', async () => {
    const before = screen([...STATUS, ['Big Mac', 120, 300], ['Add', 300, 300]]);
    const after = screen([...STATUS, ['Big Mac', 120, 300], ['Buy', 300, 300]]);
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e5' } }, [before, after], { mode: 'assisted' });
    expect(r.performed).toEqual([]);
    expect(r.text).toMatch(/no longer at/);
  });

  it('a point target whose label changed (Add → Yes)', async () => {
    const before = screen([...STATUS, ['Big Mac', 120, 300], ['Add', 300, 300]]);
    const after = screen([...STATUS, ['Big Mac', 120, 300], ['Yes', 300, 300]]);
    const r = await approveThenChange({ name: 'tap', args: { x: 300, y: 300 } }, [before, after], { mode: 'assisted' });
    expect(r.performed).toEqual([]);
    expect(r.text).toMatch(/is now “Yes”/);
  });
});

describe('unlabeled icons are checked by the labels around them', () => {
  it('Supervised: tapping the chevron of a "Delete Account" row by element id asks for approval, like a coordinate tap there', async () => {
    const s = screen([...STATUS, ['Apple Account', 178, 120], ['Delete Account', 110, 400]], [[330, 400]]);
    const byId = await approveThenChange({ name: 'tap', args: { element_id: 'e6' } }, [s]);
    expect(byId.asked?.reasons.join(' ')).toMatch(/Delete Account/);
    const byPoint = await approveThenChange({ name: 'tap', args: { x: 330, y: 400 } }, [s]);
    expect(byPoint.asked).not.toBeNull();
  });

  it('Supervised: an icon next to a blocked app is refused outright', async () => {
    const s = screen([...STATUS, ['Wallet', 61, 558]], [[61, 520]]);
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e5' } }, [s]);
    expect(r.asked).toBeNull();
    expect(r.performed).toEqual([]);
    expect(r.text).toMatch(/BLOCKED/);
  });

  it('Supervised: a harmless icon still runs without approval', async () => {
    const s = screen([...STATUS, ['Settings', 61, 558]], [[61, 520]]);
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e5' } }, [s]);
    expect(r.asked).toBeNull();
    expect(r.performed.map((a) => a.kind)).toEqual(['tap']);
  });

  it('an approved icon tap is refused when a sensitive label appeared next to it', async () => {
    // Approved in Assisted mode on "Details"; while the card was open the row became "Delete".
    const before = screen([...STATUS, ...ORDER, ['Details', 150, 700]], [[300, 700]]);
    const after = screen([...STATUS, ...ORDER, ['Delete', 150, 700]], [[300, 700]]);
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e9' } }, [before, after], { mode: 'assisted' });
    expect(r.performed).toEqual([]);
    expect(r.text).toMatch(/NOT performed/);
  });
});

describe('payment buttons ask for approval in Supervised mode', () => {
  it('"Pay SAR 49.00", "Order now", "اطلب الآن" and "Payment method" need approval; "Payload size" does not', async () => {
    for (const label of ['Pay SAR 49.00', 'Order now', 'اطلب الآن', 'Payment method']) {
      const s = screen([...STATUS, ...ORDER, [label, 178, 700]]);
      const r = await approveThenChange({ name: 'tap', args: { element_id: 'e8' } }, [s]);
      expect(r.asked?.reasons.join(' '), label).toMatch(/Payments, purchases and transfers/);
    }
    const harmless = screen([...STATUS, ...ORDER, ['Payload size', 178, 700]]);
    const r = await approveThenChange({ name: 'tap', args: { element_id: 'e8' } }, [harmless]);
    expect(r.asked).toBeNull();
  });
});
