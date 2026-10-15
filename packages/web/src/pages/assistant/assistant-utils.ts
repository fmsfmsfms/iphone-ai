// Pure helpers for the AI Assistant page: conversation titles and grouping,
// and why a new instruction can't be sent. Readable failure explanations live
// with the shared chat components.

import type { AgentTask, AppSettings, Conversation, DeviceStatus } from '@iphone-ai/shared';

import type { SessionInfo } from '../../lib/api';
import { composerDisabledReason, providerReadiness } from '../../lib/device-state';

export { explainTaskFailure, type FailureAction, type FailureExplanation, type FailureKind } from '../../components/chat/task-ui';

/** Title the backend gives new conversations; it is replaced by the first message. */
export const DEFAULT_CONVERSATION_TITLE = 'New conversation';

export function isUntitled(conversation: Pick<Conversation, 'title'>): boolean {
  const title = conversation.title.trim();
  return title.length === 0 || title === DEFAULT_CONVERSATION_TITLE;
}

export function sortConversations(list: readonly Conversation[]): Conversation[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function filterConversations(list: readonly Conversation[], query: string): Conversation[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return list.slice();
  return list.filter((c) => c.title.toLocaleLowerCase().includes(q));
}

export type ConversationGroup = 'today' | 'yesterday' | 'week' | 'older';

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Groups (already sorted) conversations by last activity relative to `now`. */
export function groupConversations(list: readonly Conversation[], now: number): { group: ConversationGroup; items: Conversation[] }[] {
  const today = startOfDay(now);
  const yesterday = today - 24 * 3600 * 1000;
  const week = today - 6 * 24 * 3600 * 1000;
  const groups: Record<ConversationGroup, Conversation[]> = { today: [], yesterday: [], week: [], older: [] };
  for (const c of list) {
    if (c.updatedAt >= today) groups.today.push(c);
    else if (c.updatedAt >= yesterday) groups.yesterday.push(c);
    else if (c.updatedAt >= week) groups.week.push(c);
    else groups.older.push(c);
  }
  return (['today', 'yesterday', 'week', 'older'] as const).filter((g) => groups[g].length > 0).map((group) => ({ group, items: groups[group] }));
}

/** Picks the conversation to open next after `removedId` disappears from the (sorted) list. */
export function nextConversationAfterRemoval(list: readonly Conversation[], removedId: string): Conversation | null {
  const index = list.findIndex((c) => c.id === removedId);
  const rest = list.filter((c) => c.id !== removedId);
  if (rest.length === 0) return null;
  return rest[Math.min(Math.max(index, 0), rest.length - 1)] ?? null;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface Reason {
  key: string;
  vars?: Record<string, string | number>;
  action?: 'settings-ai' | 'live' | 'dashboard' | 'open-task' | null;
}

export interface SendContext {
  settings: AppSettings | null;
  session: SessionInfo | null;
  status: DeviceStatus | null;
  stopLatched: boolean;
  activeTask: AgentTask | null;
  connected: boolean;
  conversationId: string | null;
}

/** Whether the selected provider sends data off this Mac and the user hasn't acknowledged that yet. */
export { needsCloudDisclosure } from '../../lib/device-state';

/**
 * Why a new instruction can't be sent right now (null when it can). Extends
 * the shared composer rules with the device checks the backend enforces when
 * a task starts (MCP ready, Mirroring connected, Screen Recording granted).
 * The cloud disclosure is handled separately (it has its own notice).
 */
export function assistantBlockReason(ctx: SendContext): Reason | null {
  const base = composerDisabledReason(ctx);
  if (base === 'composer.reason.noProvider') {
    const readiness = providerReadiness(ctx.settings);
    if (readiness.provider && readiness.reasonKey) {
      return { key: 'assistant.reason.provider', vars: { provider: readiness.provider.label, reasonKey: readiness.reasonKey }, action: 'settings-ai' };
    }
    return { key: base, action: 'settings-ai' };
  }
  if (base === 'composer.reason.taskRunning') {
    const elsewhere = ctx.activeTask && ctx.activeTask.conversationId !== ctx.conversationId;
    return elsewhere ? { key: 'assistant.reason.taskElsewhere', action: 'open-task' } : { key: base };
  }
  if (base) return { key: base };
  const status = ctx.status;
  if (!status) return { key: 'assistant.reason.loading' };
  if (status.server.state !== 'ready') return { key: 'assistant.reason.mcp', action: 'dashboard' };
  if (status.permissions.screenRecording !== 'granted') return { key: 'assistant.reason.screenRecording', action: 'dashboard' };
  if (status.mirroring.state === 'paused') return { key: 'assistant.reason.paused', action: 'live' };
  if (status.mirroring.state !== 'connected') return { key: 'assistant.reason.notConnected', action: 'live' };
  return null;
}

/** Example instructions shown in an empty conversation (i18n keys). */
export const EXAMPLE_PROMPT_KEYS: readonly string[] = [
  'assistant.example.settings',
  'assistant.example.battery',
  'assistant.example.wifi',
  'assistant.example.explain',
  'assistant.example.safari',
  'assistant.example.notifications',
];

export type Translate = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

/** Translates a Reason, resolving a nested `reasonKey` variable into `{reason}`. */
export function reasonText(reason: Reason, t: Translate): string {
  const vars: Record<string, string | number> = { ...(reason.vars ?? {}) };
  if (typeof vars['reasonKey'] === 'string') vars['reason'] = t(vars['reasonKey']);
  return t(reason.key, vars);
}
