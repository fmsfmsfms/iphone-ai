// Workflow step catalogue: menu groups, defaults for new steps, validation
// against the shared zod schema and one-line summaries. Pure (no React), so
// it can be unit-tested.

import { workflowStepSchema, type WorkflowStep, type WorkflowStepType } from '@iphone-ai/shared';

export type StepGroup = 'apps' | 'touch' | 'keyboard' | 'check' | 'ai' | 'flow';

/** Add-step menu order. Every WorkflowStep type appears exactly once. */
export const STEP_GROUPS: readonly { group: StepGroup; types: readonly WorkflowStepType[] }[] = [
  { group: 'apps', types: ['launch_app', 'press_home', 'press_back', 'open_url'] },
  { group: 'touch', types: ['tap_text', 'long_press_text', 'scroll_to', 'swipe', 'tap_point'] },
  { group: 'keyboard', types: ['type_text', 'press_key'] },
  { group: 'check', types: ['wait_for_text', 'assert_text', 'read_screen', 'screenshot'] },
  { group: 'ai', types: ['ai_task'] },
  { group: 'flow', types: ['checkpoint', 'wait'] },
];

export const STEP_TYPES: readonly WorkflowStepType[] = STEP_GROUPS.flatMap((g) => g.types);

/** i18n keys for a step type's friendly name and description. */
export function stepNameKey(type: WorkflowStepType): string {
  return `automations.stepType.${type}.name`;
}
export function stepDescriptionKey(type: WorkflowStepType): string {
  return `automations.stepType.${type}.description`;
}

/** Steps that can only work with an AI provider configured. */
export function stepNeedsAi(step: WorkflowStep): boolean {
  return step.type === 'ai_task' || (step.type === 'read_screen' && Boolean(step.instruction?.trim()));
}

let idCounter = 0;
/** Unique step id (≤ 64 chars, as the schema requires). */
export function newStepId(): string {
  idCounter += 1;
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `s_${Date.now().toString(36)}${idCounter.toString(36)}${random}`;
}

export interface StepContext {
  /** Live window geometry ("WxH"), used to stamp hand-made coordinate taps. */
  geometryId?: string | null;
}

/** A new step of `type` with sensible defaults (labels start empty and must be filled in). */
export function createStep(type: WorkflowStepType, id: string = newStepId(), ctx: StepContext = {}): WorkflowStep {
  switch (type) {
    case 'launch_app':
      return { id, type, app: '' };
    case 'tap_text':
      return { id, type, label: '' };
    case 'long_press_text':
      return { id, type, label: '' };
    case 'tap_point':
      return { id, type, x: 0, y: 0, geometryId: ctx.geometryId ?? null };
    case 'swipe':
      return { id, type, direction: 'up', distance: 'medium' };
    case 'type_text':
      return { id, type, text: '' };
    case 'press_key':
      return { id, type, key: 'return' };
    case 'press_home':
      return { id, type };
    case 'press_back':
      return { id, type };
    case 'open_url':
      return { id, type, url: 'https://' };
    case 'scroll_to':
      return { id, type, label: '' };
    case 'wait_for_text':
      return { id, type, label: '' };
    case 'assert_text':
      return { id, type, label: '', present: true };
    case 'screenshot':
      return { id, type, label: '' };
    case 'read_screen':
      return { id, type, saveAs: 'value' };
    case 'ai_task':
      return { id, type, instruction: '' };
    case 'checkpoint':
      return { id, type, message: '' };
    case 'wait':
      return { id, type, ms: 1000 };
  }
}

/** Removes optional fields that are empty (undefined, NaN, blank strings) so the schema sees them as absent. */
export function cleanStep(step: WorkflowStep): WorkflowStep {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step)) {
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    if ((key === 'note' || key === 'instruction') && typeof value === 'string' && value.trim() === '' && step.type !== 'ai_task') continue;
    out[key] = value;
  }
  return out as unknown as WorkflowStep;
}

export interface StepIssue {
  /** Field name ('' for the step as a whole). */
  field: string;
  /** i18n key under automations.validation.* */
  key: string;
  vars?: Record<string, number | string>;
}

interface ZodIssueLike {
  code: string;
  path: readonly PropertyKey[];
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
  format?: string;
}

function issueKey(issue: ZodIssueLike): Pick<StepIssue, 'key' | 'vars'> {
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string') return { key: 'automations.validation.required' };
      return { key: 'automations.validation.min', vars: { min: Number(issue.minimum ?? 0) } };
    case 'too_big':
      if (issue.origin === 'string') return { key: 'automations.validation.tooLong', vars: { max: Number(issue.maximum ?? 0) } };
      return { key: 'automations.validation.max', vars: { max: Number(issue.maximum ?? 0) } };
    case 'invalid_format':
      return { key: issue.format === 'url' ? 'automations.validation.url' : 'automations.validation.invalid' };
    case 'invalid_type':
      return { key: 'automations.validation.required' };
    default:
      return { key: 'automations.validation.invalid' };
  }
}

const VARIABLE_NAME = /^[A-Za-z0-9_-]{1,60}$/;

/** Validates one step with the shared workflowStepSchema (plus the variable-name rule the engine relies on). */
export function validateStep(step: WorkflowStep): StepIssue[] {
  const issues: StepIssue[] = [];
  const result = workflowStepSchema.safeParse(cleanStep(step));
  if (!result.success) {
    const seen = new Set<string>();
    for (const issue of result.error.issues as unknown as ZodIssueLike[]) {
      const field = typeof issue.path[0] === 'string' ? issue.path[0] : '';
      if (seen.has(field)) continue;
      seen.add(field);
      issues.push({ field, ...issueKey(issue) });
    }
  }
  if (step.type === 'read_screen' && step.saveAs.trim() && !VARIABLE_NAME.test(step.saveAs) && !issues.some((i) => i.field === 'saveAs')) {
    issues.push({ field: 'saveAs', key: 'automations.validation.variableName' });
  }
  return issues;
}

export type Translate = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

function quoted(t: Translate, value: string): string {
  const trimmed = value.trim();
  return trimmed ? t('automations.summary.quoted', { text: trimmed }) : t('automations.summary.blank');
}

function seconds(ms: number): number | string {
  return Number.isFinite(ms) ? Math.round((ms / 1000) * 10) / 10 : '…';
}

/** One readable line describing what a step does (sensitive text is never shown). */
export function summarizeStep(step: WorkflowStep, t: Translate): string {
  switch (step.type) {
    case 'launch_app':
      return t('automations.summary.launch_app', { app: quoted(t, step.app) });
    case 'tap_text':
      return t(step.exact ? 'automations.summary.tap_text_exact' : 'automations.summary.tap_text', { label: quoted(t, step.label) });
    case 'long_press_text':
      return t('automations.summary.long_press_text', { label: quoted(t, step.label) });
    case 'tap_point':
      return t('automations.summary.tap_point', { x: Math.round(step.x || 0), y: Math.round(step.y || 0) });
    case 'swipe':
      return t('automations.summary.swipe', {
        direction: t(`automations.directionWord.${step.direction}`),
        distance: t(`automations.distance.${step.distance ?? 'medium'}`),
      });
    case 'type_text':
      if (step.sensitive) return t('automations.summary.type_text_sensitive', { count: step.text.length });
      return t('automations.summary.type_text', { text: quoted(t, step.text) });
    case 'press_key':
      return t('automations.summary.press_key', { key: step.key || '…' });
    case 'press_home':
      return t('automations.summary.press_home');
    case 'press_back':
      return t('automations.summary.press_back');
    case 'open_url':
      return t('automations.summary.open_url', { url: step.url || '…' });
    case 'scroll_to':
      return t('automations.summary.scroll_to', { label: quoted(t, step.label) });
    case 'wait_for_text':
      return step.timeoutMs
        ? t('automations.summary.wait_for_text_timeout', { label: quoted(t, step.label), seconds: seconds(step.timeoutMs) })
        : t('automations.summary.wait_for_text', { label: quoted(t, step.label) });
    case 'assert_text':
      return t(step.present ? 'automations.summary.assert_present' : 'automations.summary.assert_absent', { label: quoted(t, step.label) });
    case 'screenshot':
      return t('automations.summary.screenshot', { label: quoted(t, step.label) });
    case 'read_screen':
      return step.instruction?.trim()
        ? t('automations.summary.read_screen_instruction', { instruction: step.instruction.trim(), name: step.saveAs })
        : t('automations.summary.read_screen', { name: step.saveAs });
    case 'ai_task':
      return t('automations.summary.ai_task', { instruction: quoted(t, step.instruction) });
    case 'checkpoint':
      return t('automations.summary.checkpoint', { message: quoted(t, step.message) });
    case 'wait':
      return t('automations.summary.wait', { seconds: seconds(step.ms) });
  }
}

/** Parses a geometry id ("410x890") into window points. */
export function parseGeometryId(id: string | null | undefined): { width: number; height: number } | null {
  if (!id) return null;
  const match = /^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i.exec(id.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/** Common Mirroir key names offered as quick picks for press_key steps. */
export const COMMON_KEYS: readonly string[] = ['return', 'delete', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right'];
