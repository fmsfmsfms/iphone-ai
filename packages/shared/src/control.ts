// Control modes, device actions, policy decisions and approvals.

export type ControlMode = 'observe' | 'assisted' | 'supervised';

export const CONTROL_MODES: readonly ControlMode[] = ['observe', 'assisted', 'supervised'];

export type Actor = 'user' | 'ai' | 'workflow' | 'system' | 'remote-user';

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

/**
 * A device action expressed in Mirroir's coordinate space (window points).
 * Every action is executed through the per-device serialized queue.
 */
export type DeviceAction =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'double_tap'; x: number; y: number }
  | { kind: 'long_press'; x: number; y: number; durationMs?: number }
  | { kind: 'swipe'; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }
  | {
      kind: 'drag';
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs?: number;
    }
  | { kind: 'type_text'; text: string }
  | { kind: 'press_key'; key: string; modifiers?: string[] }
  | { kind: 'press_home' }
  | { kind: 'press_back' }
  | { kind: 'press_app_switcher' }
  | { kind: 'spotlight' }
  | { kind: 'launch_app'; name: string }
  | { kind: 'open_url'; url: string }
  | { kind: 'scroll_to'; label: string; direction?: SwipeDirection; maxScrolls?: number };

export type DeviceActionKind = DeviceAction['kind'];

/** Maps each app-level action to the Mirroir MCP tool that performs it. */
export const ACTION_TOOL: Record<DeviceActionKind, string> = {
  tap: 'tap',
  double_tap: 'double_tap',
  long_press: 'long_press',
  swipe: 'swipe',
  drag: 'drag',
  type_text: 'type_text',
  press_key: 'press_key',
  press_home: 'press_home',
  press_back: 'press_back',
  press_app_switcher: 'press_app_switcher',
  spotlight: 'spotlight',
  launch_app: 'launch_app',
  open_url: 'open_url',
  scroll_to: 'scroll_to',
};

export type RiskLevel = 'low' | 'medium' | 'high';

export type PolicyVerdict = 'allow' | 'require_approval' | 'deny';

export interface PolicyDecision {
  verdict: PolicyVerdict;
  risk: RiskLevel;
  /** Human-readable reasons (shown in approval cards and the audit log). */
  reasons: string[];
  /** Policy rule identifiers that fired, e.g. "mode.observe", "blocked_app", "sensitive.send". */
  rules: string[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ApprovalRequest {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  actor: Actor;
  taskId: string | null;
  workflowRunId: string | null;
  /** Short description: "Tap "Send" (e14) in Messages". */
  summary: string;
  /** Redacted display copy of the action. */
  action: { tool: string; args: Record<string, unknown> };
  risk: RiskLevel;
  reasons: string[];
  /** Frame sequence number shown to the user when approval was requested. */
  frameSeq: number | null;
  decidedAt: number | null;
  decidedBy: string | null;
  note: string | null;
}

export interface ManualActionRequest {
  action: DeviceAction;
  /** Geometry the client used to compute coordinates; actions are refused if it is stale. */
  geometryId: string | null;
  frameSeq: number | null;
}

export interface ActionResult {
  ok: boolean;
  tool: string;
  durationMs: number;
  /** Text returned by Mirroir (redacted where needed). */
  message: string;
  /** True if Mirroir activated iPhone Mirroring (focus left iPhone AI). */
  focusChanged: boolean;
}
