// Device-wide "typed but not yet sent" state.
//
// The commit-after-typing approval used to rely on a per-task flag, so a draft
// typed by an earlier task, a workflow step or the user by hand could be sent
// by a later task's unlabeled tap without approval. This state follows every
// device action instead (DeviceController emits 'action' for every actor):
//  • typing sets it (unless the text itself ends with a line break);
//  • going Home or opening an app clears it;
//  • the person's own Return or tap clears it (they committed it themselves);
//  • for the AI and workflows only an AUTHORISED commit clears it (approved, or
//    allowed outright in AI Mode).

import type { Actor, DeviceAction, PolicyDecision } from '@iphone-ai/shared';

const COMMIT_KEYS = new Set(['return', 'enter']);
const POINTER_KINDS = new Set(['tap', 'double_tap', 'long_press']);

export interface TypingActionEvent {
  action: DeviceAction;
  ctx: { actor: Actor; approvalId?: string | null; decision: PolicyDecision };
  ok: boolean;
}

export function nextUncommittedTyping(current: boolean, event: TypingActionEvent): boolean {
  const { action, ctx, ok } = event;
  if (action.kind === 'type_text') {
    // A failed call may still have typed part of the text.
    return ok ? !/[\r\n]$/.test(action.text) : true;
  }
  if (!ok) return current;
  if (action.kind === 'press_home' || action.kind === 'launch_app') return false;
  const commitLike = POINTER_KINDS.has(action.kind) || (action.kind === 'press_key' && COMMIT_KEYS.has(action.key.toLowerCase()));
  if (!commitLike) return current;
  if (ctx.actor === 'user' || ctx.actor === 'remote-user') return false;
  if ((ctx.approvalId || ctx.decision.verdict === 'allow') && ctx.decision.rules.includes('commit.after_typing')) return false;
  return current;
}
