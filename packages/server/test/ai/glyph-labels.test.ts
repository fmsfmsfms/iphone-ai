// OCR reads icons as stray glyphs ("a", ">", "X"). Such a label must not make a
// tap target count as known: not for the commit-after-typing approval, and not
// to hide sensitive text in the same row. Replays the real-device incident of
// 2026-10-15 (Jahez search: an approved tap refused by the re-check, then the
// same tap re-issued on a field now read as "a" ran without approval). Runs in
// Assisted mode, where the approval card names what the policy flagged (AI Mode
// never shows one). Fake device driving the real AgentToolkit; no Mirroir, no phone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionResult, DeviceAction, ScreenDescription, ScreenElement } from '@iphone-ai/shared';

import { AgentToolkit } from '../../src/ai/agent/toolkit.js';
import { ScreenshotStore } from '../../src/ai/screenshots.js';
import type { DeviceController } from '../../src/device/device-controller.js';
import { makeGeometry } from '../../src/mcp/parsers.js';
import { ApprovalBroker } from '../../src/policy/approvals.js';
import { isReadableLabel } from '../../src/policy/target.js';
import { createCoreContext, type CoreContext } from '../helpers/context.js';

let ctx: CoreContext;
beforeEach(() => { ctx = createCoreContext({ settings: { permissions: { controlMode: 'assisted' }, ai: { settleDelayMs: 100 } } }); });
afterEach(async () => { await ctx.cleanup(); });

type E = [string, number, number];
let fp = 0;
function screen(elements: E[], icons: [number, number][] = []): () => ScreenDescription {
  const fingerprint = `fp${++fp}`;
  return () => ({
    capturedAt: Date.now(),
    elements: [
      ...elements.map(([label, x, y], i): ScreenElement => ({ id: `e${i + 1}`, label, x, y, kind: 'text' })),
      ...icons.map(([x, y], i): ScreenElement => ({ id: `e${elements.length + i + 1}`, label: '', x, y, kind: 'icon ~24pt' })),
    ],
    rawText: '', imageBase64: null, imageMimeType: null, geometry: makeGeometry(356, 785, 'portrait'), fingerprint,
  });
}

function kitWith(screens: (() => ScreenDescription)[], approve = true) {
  const performed: DeviceAction[] = [];
  let describes = 0;
  const device = {
    describe: async () => screens[Math.min(describes++, screens.length - 1)]!(),
    perform: async (action: DeviceAction): Promise<ActionResult> => { performed.push(action); return { ok: true, tool: action.kind, durationMs: 1, message: 'ok', focusChanged: true }; },
    geometry: makeGeometry(356, 785, 'portrait'), isStopLatched: false, getLatestFrame: () => null,
  } as unknown as DeviceController;
  const approvals = new ApprovalBroker(ctx.db, ctx.hub, ctx.activity);
  const kit = new AgentToolkit(
    { device, approvals, settings: ctx.settings, activity: ctx.activity, screenshots: new ScreenshotStore(ctx.db, ctx.paths, ctx.settings) },
    { taskId: 'task_1', leaseId: 'lease_1', signal: new AbortController().signal, vision: false, maxActions: 10, mode: 'assisted',
      addStep: () => undefined, setActivity: () => undefined, setAwaitingApproval: () => undefined, waitIfPaused: async () => undefined, onActionsUsed: () => undefined, uncommittedTyping: () => false },
  );
  const asked: string[][] = [];
  async function call(name: string, args: Record<string, unknown>) {
    const running = kit.execute({ id: 'c' + Math.random(), name, args: { reason: 'test', ...args } });
    let settled = false; running.then(() => (settled = true), () => (settled = true));
    for (let i = 0; i < 100 && !settled; i += 1) {
      const p = approvals.listPending()[0];
      if (p) { asked.push(p.reasons); approvals.decide(p.id, approve ? 'approved' : 'rejected', 'user'); }
      else await new Promise((r) => setTimeout(r, 10));
    }
    const out = await running;
    return out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  }
  return { kit, call, performed, asked, describes: () => describes };
}

describe('the real-device incident', () => {
  it('flags the same coordinate tap as a possible send after a refused re-check when the target now reads "a"', async () => {
    const s0 = screen([['WOL:Z1', 71, 63], ['asaayp @', 65, 104], ['cheese - atü d,g o', 177, 301]]);
    const sTyped = screen([['WOL:Z1', 71, 63], ['asaayp @', 65, 104], ['cheese - atü d,g o', 177, 301], ['x', 10, 700]]);
    const sRecheck = screen([['12:11', 72, 63], ['a', 282, 104], ['• cheese', 66, 104], ['cheese - aü dg o', 177, 301]]);
    const sAfter = screen([['12:11 >', 67, 61], ["McDonald's KSA", 128, 202]]);
    // (The approved type_text re-checks s0 before it runs.)
    const h = kitWith([s0, s0, sTyped, sRecheck, sRecheck, sAfter]);
    await h.kit.observe();
    await h.call('type_text', { text: 'cheese' });
    expect(h.performed.map((a) => a.kind)).toEqual(['type_text']);
    await h.call('tap', { x: 322, y: 104 });
    // Approved, then refused by the re-check: the label at the point changed.
    expect(h.performed.map((a) => a.kind)).toEqual(['type_text']);
    const before = h.asked.length;
    await h.call('tap', { x: 322, y: 104 });
    expect(h.asked.length).toBe(before + 1);
    expect(h.asked.at(-1)!.join(' ')).toMatch(/may send or submit/);
  });

  it('flags it too when the re-issued tap names the "a" element instead', async () => {
    const s0 = screen([['asaayp @', 65, 104], ['cheese', 177, 301]]);
    const sRecheck = screen([['a', 282, 104], ['• cheese', 66, 104], ['cheese', 177, 301]]);
    const h = kitWith([s0, s0, s0, sRecheck, sRecheck, sRecheck]);
    await h.kit.observe();
    await h.call('type_text', { text: 'cheese' });
    await h.call('tap', { x: 322, y: 104 });
    const before = h.asked.length;
    await h.call('tap', { element_id: 'e1' });
    expect(h.asked.length).toBe(before + 1);
    expect(h.asked.at(-1)!.join(' ')).toMatch(/may send or submit/);
  });
});

describe('a glyph at the tap point does not hide its row', () => {
  it('flags a coordinate tap on ">" in the "Delete Account" row, as without the glyph', async () => {
    for (const withGlyph of [false, true]) {
      const els: E[] = [['Settings', 178, 100], ['Delete Account', 100, 300]];
      if (withGlyph) els.push(['>', 330, 300]);
      const h = kitWith([screen(els)], false);
      await h.kit.observe();
      await h.call('tap', { x: 330, y: 300 });
      expect(h.asked.length, `glyph: ${withGlyph}`).toBe(1);
      expect(h.asked[0]!.join(' '), `glyph: ${withGlyph}`).toMatch(/Delete Account/);
      expect(h.performed, `glyph: ${withGlyph}`).toEqual([]);
    }
  });

  it('treats an element read as "X" like an unlabeled icon next to "Delete Account"', async () => {
    const glyph = kitWith([screen([['Delete Account', 100, 300], ['X', 330, 300]])], false);
    await glyph.kit.observe();
    await glyph.call('tap', { element_id: 'e2' });
    const icon = kitWith([screen([['Delete Account', 100, 300]], [[330, 300]])], false);
    await icon.kit.observe();
    await icon.call('tap', { element_id: 'e2' });
    expect(glyph.asked.length).toBe(1);
    expect(icon.asked.length).toBe(1);
    expect(glyph.asked[0]!.join(' ')).toMatch(/Delete Account/);
    expect(icon.asked[0]!.join(' ')).toMatch(/Delete Account/);
    expect(glyph.performed).toEqual([]);
    expect(icon.performed).toEqual([]);
  });
});

describe('isReadableLabel', () => {
  it('needs two letters or digits in a row (diacritics ignored)', () => {
    // (NFKC turns '①②' and '²²' into the digits '12' and '22', which are readable.)
    for (const label of ['a', 'a b', '@@', '--', '->', '↑', '😀😀', 'ــ', 'ˆˆ', ' ', '1 1', 'َُ']) {
      expect(isReadableLabel(label), JSON.stringify(label)).toBe(false);
    }
    for (const label of ['OK', 'Go', 'TV', 'iCloud', 'Wi-Fi', '12', 'ab', '发送', 'مَن', 'نعم']) {
      expect(isReadableLabel(label), JSON.stringify(label)).toBe(true);
    }
  });
});
