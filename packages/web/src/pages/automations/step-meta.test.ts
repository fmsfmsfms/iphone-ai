import { workflowStepSchema, type WorkflowStep, type WorkflowStepType } from '@iphone-ai/shared';
import { describe, expect, it } from 'vitest';

import './messages';
import { translate } from '../../lib/i18n';
import { cleanStep, createStep, newStepId, parseGeometryId, STEP_GROUPS, STEP_TYPES, summarizeStep, validateStep } from './step-meta';

const t = (key: string, vars?: Record<string, string | number | null | undefined>) => translate('en', key, vars);

function schemaTypes(): string[] {
  return workflowStepSchema.options.map((option) => {
    const literal = option.shape.type as unknown as { value: string };
    return literal.value;
  });
}

describe('step catalogue', () => {
  it('lists every WorkflowStep type exactly once', () => {
    const types = schemaTypes();
    expect([...STEP_TYPES].sort()).toEqual([...types].sort());
    expect(new Set(STEP_TYPES).size).toBe(STEP_TYPES.length);
    expect(STEP_GROUPS.every((g) => g.types.length > 0)).toBe(true);
  });

  it('has a friendly name and description for every type', () => {
    for (const type of STEP_TYPES) {
      expect(translate('en', `automations.stepType.${type}.name`)).not.toContain('automations.');
      expect(translate('ar', `automations.stepType.${type}.description`)).not.toContain('automations.');
    }
  });

  it('creates unique, schema-sized ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newStepId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(64);
  });
});

describe('createStep / validateStep', () => {
  // Values that make each default step valid.
  const fill: Partial<Record<WorkflowStepType, Record<string, unknown>>> = {
    launch_app: { app: 'Settings' },
    tap_text: { label: 'General' },
    long_press_text: { label: 'Photos' },
    type_text: { text: 'hello' },
    open_url: { url: 'https://example.com' },
    scroll_to: { label: 'Privacy' },
    wait_for_text: { label: 'Wi-Fi' },
    assert_text: { label: 'Connected' },
    screenshot: { label: 'result' },
    ai_task: { instruction: 'Dismiss the pop-up' },
    checkpoint: { message: 'Check before sending' },
  };

  it('produces steps the shared schema accepts once required text is filled in', () => {
    for (const type of STEP_TYPES) {
      const step = { ...createStep(type, 's1', { geometryId: '410x890' }), ...(fill[type] ?? {}) } as WorkflowStep;
      expect(validateStep(step), type).toEqual([]);
      expect(workflowStepSchema.safeParse(cleanStep(step)).success, type).toBe(true);
    }
  });

  it('stamps hand-made coordinate taps with the live geometry', () => {
    const step = createStep('tap_point', 's1', { geometryId: '410x890' });
    expect(step).toMatchObject({ type: 'tap_point', geometryId: '410x890' });
  });

  it('reports missing text as required', () => {
    expect(validateStep(createStep('tap_text', 's1'))).toEqual([{ field: 'label', key: 'automations.validation.required' }]);
    expect(validateStep(createStep('launch_app', 's1'))).toEqual([{ field: 'app', key: 'automations.validation.required' }]);
  });

  it('reports invalid links and out-of-range numbers', () => {
    expect(validateStep({ id: 's1', type: 'open_url', url: 'not a url' })[0]).toMatchObject({ field: 'url', key: 'automations.validation.url' });
    expect(validateStep({ id: 's1', type: 'wait', ms: 10 })[0]).toMatchObject({ field: 'ms', key: 'automations.validation.min', vars: { min: 100 } });
    expect(validateStep({ id: 's1', type: 'wait', ms: 120_000 })[0]).toMatchObject({ field: 'ms', key: 'automations.validation.max', vars: { max: 60000 } });
    expect(validateStep({ id: 's1', type: 'wait', ms: Number.NaN })[0]).toMatchObject({ field: 'ms', key: 'automations.validation.required' });
  });

  it('requires variable-safe names for read_screen', () => {
    expect(validateStep({ id: 's1', type: 'read_screen', saveAs: 'battery level' })).toEqual([
      { field: 'saveAs', key: 'automations.validation.variableName' },
    ]);
    expect(validateStep({ id: 's1', type: 'read_screen', saveAs: 'battery_level' })).toEqual([]);
  });

  it('drops empty optional fields before validation', () => {
    const cleaned = cleanStep({ id: 's1', type: 'read_screen', saveAs: 'v', instruction: '  ' });
    expect(cleaned).toEqual({ id: 's1', type: 'read_screen', saveAs: 'v' });
    const wait = cleanStep({ id: 's1', type: 'wait_for_text', label: 'x', timeoutMs: Number.NaN });
    expect(wait).toEqual({ id: 's1', type: 'wait_for_text', label: 'x' });
  });
});

describe('summarizeStep', () => {
  it('describes steps in plain words', () => {
    expect(summarizeStep({ id: 's', type: 'launch_app', app: 'Settings' }, t)).toBe('Open “Settings”');
    expect(summarizeStep({ id: 's', type: 'tap_text', label: 'General', exact: true }, t)).toBe('Tap “General” (exact match)');
    expect(summarizeStep({ id: 's', type: 'swipe', direction: 'up' }, t)).toBe('Swipe up (medium)');
    expect(summarizeStep({ id: 's', type: 'wait', ms: 1500 }, t)).toBe('Wait 1.5 s');
    expect(summarizeStep({ id: 's', type: 'read_screen', saveAs: 'total' }, t)).toBe('Read the screen into {total}');
    expect(summarizeStep({ id: 's', type: 'tap_text', label: '' }, t)).toBe('Tap (not set)');
  });

  it('never shows sensitive text', () => {
    const summary = summarizeStep({ id: 's', type: 'type_text', text: 'hunter2', sensitive: true }, t);
    expect(summary).toBe('Type 7 hidden characters');
    expect(summary).not.toContain('hunter2');
  });
});

describe('parseGeometryId', () => {
  it('parses Mirroir window sizes', () => {
    expect(parseGeometryId('410x890')).toEqual({ width: 410, height: 890 });
    expect(parseGeometryId('890×410')).toEqual({ width: 890, height: 410 });
    expect(parseGeometryId(null)).toBeNull();
    expect(parseGeometryId('garbage')).toBeNull();
    expect(parseGeometryId('0x10')).toBeNull();
  });
});
