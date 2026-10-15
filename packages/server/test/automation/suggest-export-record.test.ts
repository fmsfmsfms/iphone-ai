import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderSkillMarkdown } from '../../src/automation/skill-export.js';
import { parseSuggestion } from '../../src/automation/suggest.js';
import { HIDDEN_TEXT } from '../../src/automation/workflow-service.js';
import { createHarness, type Harness } from './fakes.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

const FENCED_REPLY = [
  'Here is a workflow:',
  '```json',
  JSON.stringify({
    name: 'Check for updates',
    description: 'Opens Software Update.',
    steps: [
      { type: 'launch_app', app: 'Settings' },
      { type: 'wait_for_text', label: 'General' },
      { type: 'tap_text', label: 'General' },
      { type: 'tap_text' },
      { type: 'open_url', url: 'https://example.com' },
      { type: 'type_text', text: '${PASSCODE}' },
      { type: 'tap_text', label: 'Software Update' },
    ],
    notes: 'Assumes English labels.',
  }),
  '```',
].join('\n');

describe('workflow suggestions', () => {
  it('parses fenced JSON, assigns ids and drops invalid steps with notes', () => {
    const suggestion = parseSuggestion(FENCED_REPLY, { goal: 'check for iOS updates', geometryId: null, maxSteps: 50 });
    expect(suggestion.name).toBe('Check for updates');
    expect(suggestion.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(suggestion.steps.map((s) => s.type)).toEqual(['launch_app', 'wait_for_text', 'tap_text', 'checkpoint', 'tap_text']);
    expect(suggestion.notes).toContain('Assumes English labels.');
    expect(suggestion.notes).toMatch(/Step 4 \(tap_text\) was dropped/);
    expect(suggestion.notes).toMatch(/Step 5 \(open_url\) was dropped/);
    expect(suggestion.notes).toMatch(/Step 6 typed a secret/);
  });

  it('accepts a bare array and rejects replies without JSON', () => {
    const suggestion = parseSuggestion('[{"type":"press_home"},{"type":"wait","ms":5}]', { goal: 'go home', geometryId: null, maxSteps: 50 });
    expect(suggestion.name).toBe('go home');
    expect(suggestion.steps).toEqual([{ id: 's1', type: 'press_home' }]);
    expect(suggestion.notes).toMatch(/Step 2 \(wait\) was dropped/);
    expect(() => parseSuggestion('Sorry, I cannot help with that.', { goal: 'x', geometryId: null, maxSteps: 50 })).toThrow(/valid workflow/);
  });

  it('fills tap_point geometry from the shared screen', () => {
    const reply = '{"steps":[{"type":"tap_point","x":10,"y":20}]}';
    expect(parseSuggestion(reply, { goal: 'g', geometryId: '410x898', maxSteps: 50 }).steps).toEqual([
      { id: 's1', type: 'tap_point', x: 10, y: 20, geometryId: '410x898' },
    ]);
    expect(parseSuggestion(reply, { goal: 'g', geometryId: null, maxSteps: 50 }).steps).toEqual([]);
  });

  it('asks the provider with the documented step types and the current screen, without saving', async () => {
    h.device.current = 'settings';
    h.agents.replies.push(FENCED_REPLY);
    const suggestion = await h.service.suggest('check for iOS updates');

    expect(suggestion.steps).toHaveLength(5);
    expect(h.service.list()).toHaveLength(0);
    const request = h.agents.completions[0]!;
    for (const type of ['launch_app', 'tap_text', 'long_press_text', 'tap_point', 'swipe', 'type_text', 'press_key', 'press_home', 'press_back', 'scroll_to', 'wait_for_text', 'assert_text', 'screenshot', 'read_screen', 'ai_task', 'checkpoint', 'wait']) {
      expect(request.system).toContain(`"type":"${type}"`);
    }
    expect(request.system).toMatch(/checkpoint immediately BEFORE/);
    expect(request.system).toMatch(/Never include passwords/);
    const text = request.content[0]!.type === 'text' ? request.content[0]!.text : '';
    expect(text).toContain('Goal: check for iOS updates');
    expect(text).toContain('"General" at (205, 340)');
    expect(text).toContain('Wallet');
  });

  it('reports a missing provider clearly', async () => {
    h.agents.providerAvailable = false;
    await expect(h.service.suggest('anything')).rejects.toThrow(/No AI provider is available/);
  });
});

describe('SKILL.md export', () => {
  it('writes Mirroir-style markdown into the skills directory', () => {
    const wf = h.service.create({
      name: 'Log in to Example',
      description: 'Signs in to the Example app.',
      source: 'manual',
      steps: [
        { id: 'a', type: 'launch_app', app: 'Example' },
        { id: 'b', type: 'wait_for_text', label: 'Sign in' },
        { id: 'c', type: 'tap_text', label: 'Email' },
        { id: 'd', type: 'type_text', text: 'me@example.com' },
        { id: 'e', type: 'tap_text', label: 'Password' },
        { id: 'f', type: 'type_text', text: 'hunter2', sensitive: true },
        { id: 'g', type: 'press_key', key: 'return' },
        { id: 'h', type: 'long_press_text', label: 'Photo' },
        { id: 'i', type: 'swipe', direction: 'up' },
        { id: 'j', type: 'scroll_to', label: 'Privacy' },
        { id: 'k', type: 'assert_text', label: 'Welcome', present: true },
        { id: 'l', type: 'assert_text', label: 'Error', present: false },
        { id: 'm', type: 'screenshot', label: 'home' },
        { id: 'n', type: 'read_screen', saveAs: 'balance', instruction: 'the account balance' },
        { id: 'o', type: 'ai_task', instruction: 'Close the tips sheet' },
        { id: 'p', type: 'checkpoint', message: 'Confirm the account' },
        { id: 'q', type: 'wait', ms: 2000 },
        { id: 'r', type: 'press_home' },
        { id: 's', type: 'press_back' },
      ],
    });
    const result = h.service.exportSkill(wf.id);

    expect(result.path).toBe(path.join(h.paths.mirroirSkillsDir, 'log-in-to-example.md'));
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, 'utf8')).toBe(result.markdown);
    const md = result.markdown;
    expect(md.startsWith('---\nversion: 1\nname: Log in to Example\napp: Example\ndescription: Signs in to the Example app.\ntags: [iphone-ai]\n---\n')).toBe(true);
    const expected = [
      '1. Launch **Example**',
      '2. Wait for "Sign in" to appear',
      '3. Tap "Email"',
      '4. Type "me@example.com"',
      '5. Tap "Password"',
      '6. Type "${PASSWORD}"',
      '7. Press **return**',
      '8. Long press "Photo"',
      '9. Swipe up',
      '10. Scroll to "Privacy"',
      '11. Verify "Welcome" is visible',
      '12. Verify "Error" is not visible',
      '13. Screenshot: "home"',
      '14. Remember: the account balance as {balance}',
      '15. AI: Close the tips sheet',
      '16. Checkpoint: Confirm the account',
      '17. Wait 2 seconds',
      '18. Press Home',
      '19. Go back',
    ];
    expect(md).toContain('## Steps');
    for (const line of expected) expect(md).toContain(line);
    expect(md).not.toContain('hunter2');
  });

  it('keeps front matter on single lines', () => {
    const md = renderSkillMarkdown({
      id: 'wf_1',
      name: 'Multi\nline',
      description: '> folded\ntext',
      steps: [{ id: 's1', type: 'press_home' }],
      createdAt: 0,
      updatedAt: 0,
      lastRunAt: null,
      lastRunStatus: null,
      lastSuccessAt: null,
      source: 'manual',
    });
    expect(md).toContain('name: Multi line\n');
    expect(md).toContain('description: folded text\n');
    expect(md).not.toContain('app:');
  });
});

describe('recorder', () => {
  it('turns manual actions into steps (labels near taps, points elsewhere)', async () => {
    h.device.current = 'settings';
    const status = h.service.startRecording('Open General');
    expect(status).toMatchObject({ recording: true, name: 'Open General', steps: 0 });
    await h.service.recorderSettled();

    h.device.emitManual({ kind: 'tap', x: 210, y: 352 });
    await h.service.recorderSettled();
    h.device.emitManual({ kind: 'tap', x: 50, y: 800 });
    await h.service.recorderSettled();
    h.device.emitManual({ kind: 'tap', x: 205, y: 260 }, false); // failed → ignored
    h.device.emitManual({ kind: 'tap', x: 205, y: 260 }, true, 'workflow'); // not manual → ignored
    h.device.emitManual({ kind: 'swipe', fromX: 205, fromY: 700, toX: 210, toY: 300 });
    await h.service.recorderSettled();
    h.device.emitManual({ kind: 'type_text', text: 'hello' });
    h.device.emitManual({ kind: 'press_key', key: 'l', modifiers: ['command'] });
    h.device.emitManual({ kind: 'launch_app', name: 'Maps' });
    h.device.emitManual({ kind: 'double_tap', x: 100, y: 100 });
    expect(h.service.recorderStatus().steps).toBe(6);

    const wf = h.service.stopRecording(true)!;
    expect(wf.source).toBe('recorded');
    expect(wf.name).toBe('Open General');
    expect(wf.steps).toEqual([
      { id: 's1', type: 'tap_text', label: 'General' },
      { id: 's2', type: 'tap_point', x: 50, y: 800, geometryId: '410x898' },
      { id: 's3', type: 'swipe', direction: 'up', distance: 'long' },
      { id: 's4', type: 'type_text', text: 'hello' },
      { id: 's5', type: 'press_key', key: 'l+command' },
      { id: 's6', type: 'launch_app', app: 'Maps' },
    ]);
    expect(wf.description).toMatch(/double-tap/);
    expect(h.service.recorderStatus()).toEqual({ recording: false, name: null, startedAt: null, steps: 0 });
    expect(h.service.list()).toHaveLength(1);
  });

  it('records the Live viewer\'s swipes as swipe steps and skips click-drags', async () => {
    h.device.current = 'settings';
    h.service.startRecording('Next videos');
    await h.service.recorderSettled();
    h.device.emitManual({ kind: 'swipe', fromX: 205, fromY: 620, toX: 205, toY: 270, durationMs: 180 });
    await h.service.recorderSettled();
    h.device.emitManual({ kind: 'swipe', fromX: 330, fromY: 450, toX: 90, toY: 452, durationMs: 300 });
    await h.service.recorderSettled();
    // Long press mode sends a click-drag (sliders): workflows have no drag step.
    h.device.emitManual({ kind: 'drag', fromX: 100, fromY: 400, toX: 250, toY: 400, durationMs: 400 });
    await h.service.recorderSettled();
    const wf = h.service.stopRecording(true)!;
    expect(wf.steps.map((step) => ({ type: step.type, direction: 'direction' in step ? step.direction : null }))).toEqual([
      { type: 'swipe', direction: 'up' },
      { type: 'swipe', direction: 'left' },
    ]);
  });

  it('never stores text typed on a password screen (a checkpoint replaces it) and discards when not saving', async () => {
    h.device.screens.login = [
      { label: 'Apple Account', x: 205, y: 120 },
      { label: 'Password', x: 205, y: 300 },
    ];
    h.device.current = 'login';
    h.service.startRecording('Login');
    await h.service.recorderSettled();
    h.device.emitManual({ kind: 'type_text', text: 'secret' });
    expect(h.service.recorderStatus().steps).toBe(1);
    const recorded = h.service.stopRecording(true)!;
    expect(recorded.steps).toEqual([
      { id: 's1', type: 'checkpoint', message: 'Enter the password or code yourself on the iPhone, then approve to continue.' },
    ]);
    expect(recorded.description).toContain('Typed text on a password or code field was not recorded; a checkpoint was added instead.');
    expect(JSON.stringify(h.db.all('SELECT * FROM workflows'))).not.toContain('secret');

    h.service.startRecording('Discard me');
    await h.service.recorderSettled();
    h.device.emitManual({ kind: 'press_home' });
    expect(h.service.stopRecording(false)).toBeNull();
    expect(h.service.list()).toHaveLength(1);
  });
});

describe('stored secrets', () => {
  const steps = [
    { id: 'a', type: 'tap_text', label: 'Password' },
    { id: 'b', type: 'type_text', text: 'hunter2', sensitive: true },
    { id: 'c', type: 'type_text', text: 'hello' },
  ] as const;

  it('never returns the text of sensitive steps (the API serves these to every session)', () => {
    const created = h.service.create({ name: 'Login', description: '', steps: [...steps], source: 'manual' });
    expect(created.steps[1]).toEqual({ id: 'b', type: 'type_text', text: HIDDEN_TEXT, sensitive: true });
    expect(created.steps[2]).toEqual({ id: 'c', type: 'type_text', text: 'hello' });
    expect(JSON.stringify(h.service.list())).not.toContain('hunter2');
    expect(JSON.stringify(h.service.get(created.id))).not.toContain('hunter2');
    expect(h.service.get(created.id)!.steps[2]).toEqual({ id: 'c', type: 'type_text', text: 'hello' });
  });

  it('keeps the stored text when a hidden step is sent back unchanged, and refuses copying it', async () => {
    const created = h.service.create({ name: 'Login', description: '', steps: [...steps], source: 'manual' });
    const fetched = h.service.get(created.id)!;
    const updated = h.service.update(created.id, { name: 'Login 2', description: '', steps: fetched.steps, source: 'manual' });
    expect(updated.name).toBe('Login 2');
    expect(JSON.stringify(updated)).not.toContain('hunter2');

    // The real text is still what a run types (once typing secrets is allowed).
    h.settings.mutate((d) => {
      d.permissions.blockTypingOnAuthScreens = false;
    });
    h.device.screens.settings!.push({ label: 'Password', x: 205, y: 420 });
    h.device.current = 'settings';
    const started = await h.service.run(created.id, 'user');
    // The tap on "Password" needs approval (sensitive keyword).
    const approve = setInterval(() => {
      for (const pending of h.approvals.listPending()) h.approvals.decide(pending.id, 'approved', 'test-user');
    }, 5);
    const run = await h.service.waitForRun(started.id);
    clearInterval(approve);
    expect(run.status).toBe('succeeded');
    expect(h.device.performed.filter((p) => p.action.kind === 'type_text').map((p) => p.action)).toEqual([
      { kind: 'type_text', text: 'hunter2' },
      { kind: 'type_text', text: 'hello' },
    ]);

    // A copied hidden step has no stored text to restore.
    const copy = { ...fetched.steps[1]!, id: 'b2' };
    expect(() => h.service.update(created.id, { name: 'Login', description: '', steps: [...fetched.steps, copy], source: 'manual' })).toThrow(
      /hidden text that can't be copied/,
    );
    expect(() => h.service.create({ name: 'Copy', description: '', steps: [copy], source: 'manual' })).toThrow(/hidden text that can't be copied/);
  });
});
