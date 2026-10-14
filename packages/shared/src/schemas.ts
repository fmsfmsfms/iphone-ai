// Runtime validation (zod) for every request body the backend accepts.
// The UI uses the same schemas for form validation.

import { z } from 'zod';

const finite = z.number().finite();
const point = finite.min(0).max(4000);
const duration = z.number().int().min(50).max(10000);

export const swipeDirectionSchema = z.enum(['up', 'down', 'left', 'right']);

export const deviceActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), x: point, y: point }),
  z.object({ kind: z.literal('double_tap'), x: point, y: point }),
  z.object({ kind: z.literal('long_press'), x: point, y: point, durationMs: duration.optional() }),
  z.object({
    kind: z.literal('swipe'),
    fromX: point,
    fromY: point,
    toX: point,
    toY: point,
    durationMs: duration.optional(),
  }),
  z.object({
    kind: z.literal('drag'),
    fromX: point,
    fromY: point,
    toX: point,
    toY: point,
    durationMs: duration.optional(),
    asSwipe: z.literal(true).optional(),
  }),
  z.object({ kind: z.literal('type_text'), text: z.string().min(1).max(2000) }),
  z.object({
    kind: z.literal('press_key'),
    key: z.string().min(1).max(32),
    modifiers: z.array(z.enum(['command', 'shift', 'option', 'control'])).max(4).optional(),
  }),
  z.object({ kind: z.literal('press_home') }),
  z.object({ kind: z.literal('press_back') }),
  z.object({ kind: z.literal('press_app_switcher') }),
  z.object({ kind: z.literal('spotlight') }),
  z.object({ kind: z.literal('launch_app'), name: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('open_url'), url: z.string().url().max(2048) }),
  z.object({
    kind: z.literal('scroll_to'),
    label: z.string().min(1).max(200),
    direction: swipeDirectionSchema.optional(),
    maxScrolls: z.number().int().min(1).max(30).optional(),
  }),
]);

export const manualActionRequestSchema = z.object({
  action: deviceActionSchema,
  geometryId: z.string().max(100).nullable(),
  frameSeq: z.number().int().nullable(),
});

export const controlModeSchema = z.enum(['observe', 'assisted', 'supervised']);

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(500).optional(),
});

export const startTaskSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  providerId: z.string().max(100).optional(),
  maxActions: z.number().int().min(1).max(200).optional(),
});

const stepId = z.string().min(1).max(64);

export const workflowStepSchema = z.discriminatedUnion('type', [
  z.object({ id: stepId, type: z.literal('launch_app'), app: z.string().min(1).max(120) }),
  z.object({ id: stepId, type: z.literal('tap_text'), label: z.string().min(1).max(200), exact: z.boolean().optional() }),
  z.object({ id: stepId, type: z.literal('long_press_text'), label: z.string().min(1).max(200) }),
  z.object({
    id: stepId,
    type: z.literal('tap_point'),
    x: point,
    y: point,
    geometryId: z.string().max(100).nullable(),
    note: z.string().max(200).optional(),
  }),
  z.object({
    id: stepId,
    type: z.literal('swipe'),
    direction: swipeDirectionSchema,
    distance: z.enum(['short', 'medium', 'long']).optional(),
  }),
  z.object({ id: stepId, type: z.literal('type_text'), text: z.string().min(1).max(2000), sensitive: z.boolean().optional() }),
  z.object({ id: stepId, type: z.literal('press_key'), key: z.string().min(1).max(32) }),
  z.object({ id: stepId, type: z.literal('press_home') }),
  z.object({ id: stepId, type: z.literal('press_back') }),
  z.object({ id: stepId, type: z.literal('open_url'), url: z.string().url().max(2048) }),
  z.object({ id: stepId, type: z.literal('scroll_to'), label: z.string().min(1).max(200), direction: swipeDirectionSchema.optional() }),
  z.object({
    id: stepId,
    type: z.literal('wait_for_text'),
    label: z.string().min(1).max(200),
    timeoutMs: z.number().int().min(500).max(120000).optional(),
  }),
  z.object({ id: stepId, type: z.literal('assert_text'), label: z.string().min(1).max(200), present: z.boolean() }),
  z.object({ id: stepId, type: z.literal('screenshot'), label: z.string().min(1).max(120) }),
  z.object({
    id: stepId,
    type: z.literal('read_screen'),
    saveAs: z.string().min(1).max(60),
    instruction: z.string().max(500).optional(),
  }),
  z.object({
    id: stepId,
    type: z.literal('ai_task'),
    instruction: z.string().min(1).max(2000),
    maxActions: z.number().int().min(1).max(100).optional(),
  }),
  z.object({ id: stepId, type: z.literal('checkpoint'), message: z.string().min(1).max(500) }),
  z.object({ id: stepId, type: z.literal('wait'), ms: z.number().int().min(100).max(60000) }),
]);

export const workflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  steps: z.array(workflowStepSchema).max(200),
  source: z.enum(['manual', 'ai-suggested', 'recorded', 'imported']).default('manual'),
});

export const workflowSuggestSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  providerId: z.string().max(100).optional(),
});

export const providerConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  kind: z.enum(['anthropic', 'claude-agent-sdk', 'openai', 'openai-compatible']),
  label: z.string().trim().min(1).max(80),
  baseUrl: z.string().url().max(500).nullable(),
  model: z.string().max(200),
  vision: z.boolean(),
  maxOutputTokens: z.number().int().min(256).max(128000),
  contextTokens: z.number().int().min(2048).max(2000000).nullable(),
  timeoutMs: z.number().int().min(5000).max(900000),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  cloud: z.boolean(),
});

export const providerSecretSchema = z.object({
  apiKey: z.string().trim().min(1).max(500),
});

export const sensitiveRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().min(1).max(120),
  keywords: z.array(z.string().trim().min(1).max(80)).max(200),
  effect: z.enum(['require_approval', 'deny']),
  enabled: z.boolean(),
});

export const settingsPatchSchema = z
  .object({
    general: z
      .object({
        theme: z.enum(['dark', 'light', 'system']),
        language: z.enum(['en', 'ar']),
        notifications: z.boolean(),
        openMirroringOnLaunch: z.boolean(),
        refocusAfterManualAction: z.boolean(),
        onboardingCompleted: z.boolean(),
      })
      .partial(),
    connection: z
      .object({
        mirroirBinaryPath: z.string().min(1).max(500),
        target: z.string().min(1).max(60),
        requestTimeoutMs: z.number().int().min(5000).max(600000),
        screenshot: z.object({
          activeFps: z.number().min(0.2).max(10),
          idleFps: z.number().min(0).max(2),
          idleAfterMs: z.number().int().min(5000).max(3600000),
          pauseWhenHidden: z.boolean(),
          // Optional so older clients that send the four polling fields keep working
          // (the backend keeps the current values for omitted keys).
          liveCapture: z.boolean().optional(),
          // Up to 60 is still accepted from older clients; the backend stores at most MAX_LIVE_FPS (15).
          liveFps: z.number().int().min(5).max(60).optional(),
        }),
      })
      .partial(),
    ai: z
      .object({
        activeProviderId: z.string().max(100),
        visionProviderId: z.string().max(100).nullable(),
        maxActionsPerTask: z.number().int().min(1).max(200),
        maxTaskDurationSec: z.number().int().min(10).max(3600),
        settleDelayMs: z.number().int().min(100).max(5000),
        providers: z.array(providerConfigSchema).max(30),
      })
      .partial(),
    permissions: z
      .object({
        controlMode: controlModeSchema,
        manualControlEnabled: z.boolean(),
        aiAllowedTools: z.array(z.string().max(60)).max(60),
        blockedApps: z.array(z.string().trim().min(1).max(120)).max(500),
        sensitiveRules: z.array(sensitiveRuleSchema).max(50),
        blockTypingOnAuthScreens: z.boolean(),
        approvalTimeoutSec: z.number().int().min(10).max(3600),
        auditManualActions: z.boolean(),
      })
      .partial(),
    automation: z
      .object({
        maxStepsPerRun: z.number().int().min(1).max(500),
        maxRunDurationSec: z.number().int().min(10).max(7200),
        defaultWaitTimeoutMs: z.number().int().min(500).max(120000),
      })
      .partial(),
    privacy: z
      .object({
        storeScreenshots: z.boolean(),
        screenshotRetentionDays: z.number().int().min(1).max(365),
        logTypedText: z.boolean(),
        historyRetentionDays: z.number().int().min(1).max(3650),
        cloudDisclosureAcknowledged: z.boolean(),
      })
      .partial(),
    advanced: z.object({ debugLogging: z.boolean(), mcpTrace: z.boolean() }).partial(),
    remote: z
      .object({
        enabled: z.boolean(),
        bindAddress: z.string().max(100),
        port: z.number().int().min(1024).max(65535),
        allowRemoteControl: z.boolean(),
        sessionTtlHours: z.number().int().min(1).max(720),
      })
      .partial(),
  })
  .partial()
  .strict();

export const remotePasscodeSchema = z.object({
  passcode: z.string().min(8).max(128),
});

export const remoteLoginSchema = z.object({
  passcode: z.string().min(1).max(128),
  deviceName: z.string().trim().max(80).optional(),
});

export const activityQuerySchema = z.object({
  categories: z.string().optional(),
  severity: z.string().optional(),
  actor: z.string().optional(),
  search: z.string().max(200).optional(),
  taskId: z.string().max(100).optional(),
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  before: z.coerce.number().int().optional(),
});

export type DeviceActionInput = z.infer<typeof deviceActionSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type SettingsPatchInput = z.infer<typeof settingsPatchSchema>;
