// AI workflow suggestions: the system prompt that documents every step type
// and the safety rules, and a tolerant parser that validates the model's JSON
// with the shared zod schema. Suggestions are never saved automatically.

import { workflowStepSchema, type ScreenDescription, type WorkflowStep, type WorkflowSuggestion } from '@iphone-ai/shared';

import { WorkflowError } from './types.js';

export const SUGGEST_SYSTEM_PROMPT = `You design automation workflows for a real, physical iPhone that is controlled from a Mac through Apple's iPhone Mirroring (via the Mirroir MCP server).
A workflow is a list of steps that iPhone AI executes one by one. Text labels are matched live against the text recognised on screen (exact, then case-insensitive, then substring), so use the words the user actually sees.

STEP TYPES (JSON objects; omit "id" — it is assigned automatically):
- {"type":"launch_app","app":"Settings"} — open an app by its Home Screen name.
- {"type":"tap_text","label":"General"} — tap the element showing this visible text. Optional "exact": true for exact matching only.
- {"type":"long_press_text","label":"Photos"} — long-press the element showing this text.
- {"type":"tap_point","x":205,"y":340} — tap window coordinates in points. ONLY when the target has no visible text and the current screen below shows where it is.
- {"type":"swipe","direction":"up","distance":"long"} — direction the finger moves ("up" scrolls content down); distance is "short", "medium" or "long" (optional, default "long", which pages to the next item, e.g. the next TikTok video).
- {"type":"type_text","text":"hello"} — type into the focused field (tap the field first).
- {"type":"press_key","key":"return"} — keys: return, escape, tab, delete, space, up, down, left, right; chords like "l+command".
- {"type":"press_home"} — go to the Home Screen.
- {"type":"press_back"} — go back (in-app back navigation).
- {"type":"scroll_to","label":"Privacy & Security","direction":"up"} — scroll until the text is visible (direction optional).
- {"type":"wait_for_text","label":"Wi-Fi","timeoutMs":15000} — wait until the text appears (timeoutMs 500–120000, optional).
- {"type":"assert_text","label":"Connected","present":true} — check that text is (present: true) or is not (present: false) on screen; the run fails otherwise.
- {"type":"screenshot","label":"result"} — save a screenshot in the run history.
- {"type":"read_screen","saveAs":"total","instruction":"the order total"} — read information from the screen into {total}; later steps may use {total} inside text. "instruction" is optional.
- {"type":"ai_task","instruction":"Dismiss any pop-up that is shown","maxActions":5} — let the AI agent handle a part that cannot be scripted reliably (maxActions 1–100, optional). Use sparingly.
- {"type":"checkpoint","message":"Check the message before it is sent"} — pause and ask the user to confirm before continuing.
- {"type":"wait","ms":1000} — pause (100–60000 ms).
Never use "open_url": Mirroir cannot open URLs on iPhone. To open a website: launch_app "Safari", tap_text the address bar, type_text the address, press_key "return".

SAFETY RULES (mandatory):
1. Use visible text labels (tap_text, wait_for_text, scroll_to). Do not use coordinates unless it is unavoidable.
2. After launch_app or any navigation, add wait_for_text for a label you expect on the next screen before tapping on it.
3. Put a checkpoint immediately BEFORE any step that sends, posts, shares, replies, deletes, removes, purchases, pays, transfers money, subscribes, signs out, or changes security or privacy settings.
4. Never include passwords, passcodes, PINs, verification codes, OTPs or other secrets, and never type them. Instead add a checkpoint asking the user to enter the value themselves on the iPhone, then continue.
5. Never open or interact with banking, payment, wallet, password-manager or authenticator apps, or any app listed as blocked.
6. Keep workflows short and deterministic (at most 30 steps). If the goal cannot be done safely, return an empty "steps" list and explain why in "notes".

OUTPUT: reply with ONE JSON object and nothing else (no Markdown, no code fences):
{"name": "short title", "description": "one or two sentences", "steps": [ ... ], "notes": "assumptions, things the user must check, or why steps were left out"}`;

/** The user message for a suggestion request. */
export function buildSuggestionRequest(
  goal: string,
  options: { screen: ScreenDescription | null; blockedApps: readonly string[] },
): string {
  const parts = [`Goal: ${goal.trim()}`];
  if (options.blockedApps.length > 0) {
    parts.push(`Blocked apps (never use): ${options.blockedApps.join(', ')}`);
  }
  const screen = options.screen;
  if (screen) {
    const size = screen.geometry ? ` (window ${screen.geometry.widthPt}×${screen.geometry.heightPt} pt)` : '';
    const lines = screen.elements
      .filter((e) => e.label.trim())
      .slice(0, 150)
      .map((e) => `- "${e.label.trim()}" at (${Math.round(e.x)}, ${Math.round(e.y)})`);
    parts.push(
      lines.length > 0
        ? `Current iPhone screen${size} — visible text, top to bottom:\n${lines.join('\n')}`
        : `Current iPhone screen${size}: no text was recognised.`,
    );
  } else {
    parts.push('The current iPhone screen is not available. Start from the Home Screen (press_home) if the starting point matters.');
  }
  return parts.join('\n\n');
}

/** Strips code fences and surrounding prose and parses the first JSON value. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const candidates: string[] = [body];
  const firstObject = body.indexOf('{');
  const lastObject = body.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(body.slice(firstObject, lastObject + 1));
  const firstArray = body.indexOf('[');
  const lastArray = body.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(body.slice(firstArray, lastArray + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next candidate
    }
  }
  throw new WorkflowError("The AI's reply did not contain a valid workflow (JSON could not be parsed).", 'ai_bad_response', 502);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SECRET_PLACEHOLDER = /\$\{[^}]+\}|<[^>]*(pass(word|code)|pin|otp|code|secret)[^>]*>|\b(password|passcode)\b/i;

export interface ParseSuggestionOptions {
  goal: string;
  /** Window geometry the AI saw (fills tap_point.geometryId); null when no screen was shared. */
  geometryId: string | null;
  maxSteps: number;
}

/** Validates the model's reply into a WorkflowSuggestion (invalid steps are dropped and explained in notes). */
export function parseSuggestion(text: string, options: ParseSuggestionOptions): WorkflowSuggestion {
  const parsed = extractJson(text);
  const root: Record<string, unknown> = Array.isArray(parsed) ? { steps: parsed } : isRecord(parsed) ? parsed : {};
  const rawSteps = Array.isArray(root.steps) ? root.steps : [];
  const notes: string[] = [];
  if (typeof root.notes === 'string' && root.notes.trim()) notes.push(root.notes.trim());
  if (!Array.isArray(root.steps)) notes.push('The AI did not return a list of steps.');

  const steps: WorkflowStep[] = [];
  rawSteps.forEach((raw, index) => {
    const n = index + 1;
    if (!isRecord(raw)) {
      notes.push(`Step ${n} was dropped: it is not a step object.`);
      return;
    }
    const { id: _ignored, ...rest } = raw;
    let candidate: Record<string, unknown> = rest;
    const type = typeof candidate.type === 'string' ? candidate.type : 'unknown';

    if (type === 'open_url') {
      notes.push(`Step ${n} (open_url) was dropped: Mirroir cannot open URLs on iPhone; use launch_app Safari + type_text.`);
      return;
    }
    if (type === 'type_text' && (candidate.sensitive === true || (typeof candidate.text === 'string' && SECRET_PLACEHOLDER.test(candidate.text)))) {
      notes.push(`Step ${n} typed a secret, so it was replaced by a checkpoint: enter it yourself on the iPhone.`);
      candidate = { type: 'checkpoint', message: 'Enter the password or code yourself on the iPhone, then approve to continue.' };
    }
    if (type === 'tap_point' && (candidate.geometryId === undefined || candidate.geometryId === null)) {
      if (!options.geometryId) {
        notes.push(`Step ${n} (tap_point) was dropped: coordinates need the current screen, which was not available.`);
        return;
      }
      candidate = { ...candidate, geometryId: options.geometryId };
    }

    const result = workflowStepSchema.safeParse({ ...candidate, id: `s${steps.length + 1}` });
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
      notes.push(`Step ${n} (${type}) was dropped: ${issue?.message ?? 'invalid step'}${where}.`);
      return;
    }
    steps.push(result.data as WorkflowStep);
  });

  const limit = Math.min(options.maxSteps, 200);
  if (steps.length > limit) {
    notes.push(`The suggestion had ${steps.length} steps; only the first ${limit} were kept.`);
    steps.length = limit;
  }

  const goal = options.goal.trim();
  const name = (typeof root.name === 'string' && root.name.trim() ? root.name.trim() : goal).slice(0, 120);
  const description = (typeof root.description === 'string' && root.description.trim() ? root.description.trim() : goal).slice(0, 2000);
  return { name, description, steps, notes: notes.join('\n') };
}
