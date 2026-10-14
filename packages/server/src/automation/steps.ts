// Pure helpers shared by the step engine, recorder, suggestions and SKILL.md export.

import type { ScreenElement, SwipeDirection, WorkflowStep, WorkflowStepType } from '@iphone-ai/shared';

import { describeTypedText } from '../core/redact.js';

/** Steps that change the phone; the engine waits settings.ai.settleDelayMs after each. */
export const MUTATING_STEP_TYPES: ReadonlySet<WorkflowStepType> = new Set<WorkflowStepType>([
  'launch_app',
  'tap_text',
  'long_press_text',
  'tap_point',
  'swipe',
  'type_text',
  'press_key',
  'press_home',
  'press_back',
  'scroll_to',
  'ai_task',
]);

export type SwipeDistance = 'short' | 'medium' | 'long';

const DISTANCE_TRAVEL: Record<SwipeDistance, number> = { short: 0.2, medium: 0.35, long: 0.5 };

/**
 * Swipe endpoints in window points. `direction` is the direction the finger
 * moves ('up' scrolls content down). Without a distance a vertical swipe goes
 * 0.7h → 0.3h and a horizontal one 0.8w → 0.2w; a distance sets the travel to
 * 0.2 / 0.35 / 0.5 of the dimension, centred on the window.
 */
export function swipeCoordinates(
  widthPt: number,
  heightPt: number,
  direction: SwipeDirection,
  distance?: SwipeDistance,
): { fromX: number; fromY: number; toX: number; toY: number } {
  const vertical = direction === 'up' || direction === 'down';
  const travel = distance ? DISTANCE_TRAVEL[distance] : vertical ? 0.4 : 0.6;
  const near = 0.5 - travel / 2;
  const far = 0.5 + travel / 2;
  const cx = Math.round(widthPt / 2);
  const cy = Math.round(heightPt / 2);
  switch (direction) {
    case 'up':
      return { fromX: cx, fromY: Math.round(heightPt * far), toX: cx, toY: Math.round(heightPt * near) };
    case 'down':
      return { fromX: cx, fromY: Math.round(heightPt * near), toX: cx, toY: Math.round(heightPt * far) };
    case 'left':
      return { fromX: Math.round(widthPt * far), fromY: cy, toX: Math.round(widthPt * near), toY: cy };
    case 'right':
      return { fromX: Math.round(widthPt * near), fromY: cy, toX: Math.round(widthPt * far), toY: cy };
  }
}

/** Classifies a recorded swipe by its dominant axis and travel relative to the window. */
export function classifySwipe(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  widthPt: number | null,
  heightPt: number | null,
): { direction: SwipeDirection; distance: SwipeDistance } {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const direction: SwipeDirection = vertical ? (dy < 0 ? 'up' : 'down') : dx < 0 ? 'left' : 'right';
  const span = vertical ? heightPt : widthPt;
  const ratio = span && span > 0 ? Math.abs(vertical ? dy : dx) / span : 0.35;
  const distance: SwipeDistance = ratio < 0.275 ? 'short' : ratio < 0.425 ? 'medium' : 'long';
  return { direction, distance };
}

const MODIFIER_ALIASES: Record<string, string> = {
  command: 'command',
  cmd: 'command',
  shift: 'shift',
  option: 'option',
  opt: 'option',
  alt: 'option',
  control: 'control',
  ctrl: 'control',
};

/** Parses "return", "l+command" or "cmd+shift+z" into a key and Mirroir modifiers. */
export function parseKeyCombo(combo: string): { key: string; modifiers: string[] } {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { key: combo.trim(), modifiers: [] };
  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
    } else {
      keys.push(part);
    }
  }
  if (keys.length !== 1) return { key: combo.trim(), modifiers: [] };
  return { key: keys[0]!, modifiers };
}

/** Formats a key and modifiers the way press_key steps store them ("l+command"). */
export function formatKeyCombo(key: string, modifiers: readonly string[] | undefined): string {
  return [key, ...(modifiers ?? [])].join('+');
}

/** Nearest labelled element whose tap point is within `maxDistance` points of (x, y). */
export function nearestElement(
  elements: readonly ScreenElement[],
  x: number,
  y: number,
  maxDistance = 30,
): ScreenElement | null {
  let best: ScreenElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    if (!element.label.trim()) continue;
    const d = Math.hypot(element.x - x, element.y - y);
    if (d <= maxDistance && d < bestDistance) {
      best = element;
      bestDistance = d;
    }
  }
  return best;
}

/** Replaces {name} placeholders with values saved by earlier read_screen steps. */
export function fillVariables(text: string, vars: ReadonlyMap<string, string>): string {
  if (vars.size === 0) return text;
  return text.replace(/\{([A-Za-z0-9_-]{1,60})\}/g, (whole, name: string) => vars.get(name) ?? whole);
}

/** Gives every step a unique id (keeps valid ids, renumbers missing/duplicate ones as s1, s2, …). */
export function normalizeStepIds(steps: readonly WorkflowStep[]): WorkflowStep[] {
  const taken = new Set(steps.map((s) => (s.id ?? '').trim()).filter(Boolean));
  const seen = new Set<string>();
  let counter = 0;
  return steps.map((step) => {
    let id = (step.id ?? '').trim();
    if (!id || seen.has(id)) {
      do {
        counter += 1;
        id = `s${counter}`;
      } while (taken.has(id) || seen.has(id));
    }
    seen.add(id);
    return { ...step, id };
  });
}

function quote(text: string): string {
  return `“${text}”`;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? `${s}` : s.toFixed(1).replace(/\.0$/, '');
}

/** One readable phrase per step for the UI, approvals and the activity history. */
export function describeStep(step: WorkflowStep, options: { showTypedText?: boolean } = {}): string {
  switch (step.type) {
    case 'launch_app':
      return `Open ${step.app}`;
    case 'tap_text':
      return `Tap ${quote(step.label)}`;
    case 'long_press_text':
      return `Long-press ${quote(step.label)}`;
    case 'tap_point':
      return `Tap at (${Math.round(step.x)}, ${Math.round(step.y)})${step.note ? ` — ${step.note}` : ''}`;
    case 'swipe':
      return `Swipe ${step.direction}${step.distance ? ` (${step.distance})` : ''}`;
    case 'type_text':
      return options.showTypedText && !step.sensitive
        ? `Type ${quote(step.text.length > 80 ? `${step.text.slice(0, 80)}…` : step.text)}`
        : `Type ${describeTypedText(step.text)}`;
    case 'press_key':
      return `Press ${step.key}`;
    case 'press_home':
      return 'Go to the Home Screen';
    case 'press_back':
      return 'Go back';
    case 'open_url':
      return 'Open a link';
    case 'scroll_to':
      return `Scroll to ${quote(step.label)}`;
    case 'wait_for_text':
      return `Wait for ${quote(step.label)}`;
    case 'assert_text':
      return `Check that ${quote(step.label)} is ${step.present ? 'visible' : 'not visible'}`;
    case 'screenshot':
      return `Take a screenshot (${step.label})`;
    case 'read_screen':
      return `Read the screen into {${step.saveAs}}`;
    case 'ai_task':
      return `AI: ${step.instruction.length > 80 ? `${step.instruction.slice(0, 80)}…` : step.instruction}`;
    case 'checkpoint':
      return `Checkpoint: ${step.message}`;
    case 'wait':
      return `Wait ${seconds(step.ms)} s`;
  }
}
