// Device, connection and screen-stream types shared by the backend and the UI.

/** Lifecycle of the local Mirroir MCP server process managed by the backend. */
export type McpServerState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'crashed'
  | 'binary_missing';

/**
 * State of Apple's iPhone Mirroring session as reported by Mirroir's `status` tool.
 * `unknown` means it has not been checked yet (never assume `connected`).
 */
export type MirroringState =
  | 'unknown'
  | 'not_running'
  | 'no_window'
  | 'paused'
  | 'connected'
  | 'error';

export type Orientation = 'portrait' | 'landscape';

/** Geometry of the iPhone Mirroring window in macOS points, as reported by Mirroir. */
export interface WindowGeometry {
  widthPt: number;
  heightPt: number;
  orientation: Orientation;
  /** Stable identity used to reject touches computed against stale geometry. */
  geometryId: string;
  observedAt: number;
}

export type PermissionState = 'granted' | 'denied' | 'unknown';

export interface MacPermissions {
  screenRecording: PermissionState;
  accessibility: PermissionState;
  /** Where the value came from (e.g. "check_health", "doctor"). */
  source: string;
  checkedAt: number | null;
}

export type HealthStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheckItem {
  name: string;
  status: HealthStatus;
  detail: string;
  fixHint?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  /** True if the tool can change device state (taps, typing, navigation, …). */
  mutating: boolean;
  inputSchema: Record<string, unknown>;
}

export type ControlOwner = 'none' | 'manual' | 'ai' | 'workflow';

export interface McpServerInfo {
  state: McpServerState;
  binaryPath: string;
  pid: number | null;
  version: string | null;
  protocolVersion: string | null;
  startedAt: number | null;
  restartCount: number;
  lastError: string | null;
  tools: McpToolInfo[];
  /** Mutating tools Mirroir hides because the project-local permission file does not allow them. */
  permissionFile: string | null;
}

export interface MirroringInfo {
  state: MirroringState;
  /** Raw text from Mirroir's `status` tool, shown verbatim in diagnostics. */
  rawStatus: string;
  target: string;
  geometry: WindowGeometry | null;
  checkedAt: number | null;
}

export interface DeviceStatus {
  server: McpServerInfo;
  mirroring: MirroringInfo;
  permissions: MacPermissions;
  controlOwner: ControlOwner;
  /** Emergency stop engaged: every device action is refused until the user re-arms control. */
  stopLatched: boolean;
  stopReason: string | null;
  queueDepth: number;
  /** True while a device action is executing. */
  actionInFlight: boolean;
  /** Set when an input action activated the native iPhone Mirroring window (focus moved away from iPhone AI). */
  lastFocusSteal: number | null;
}

/** Metadata for one captured screenshot frame. Frames are polled screenshots, never a video stream. */
export interface FrameMeta {
  seq: number;
  capturedAt: number;
  /** Wall time the screenshot tool call took. */
  latencyMs: number;
  widthPx: number;
  heightPx: number;
  mimeType: string;
  /** Pixels per point (usually 2 on Retina). Null when geometry is unknown. */
  pxPerPt: number | null;
  geometry: WindowGeometry | null;
}

export interface StreamStats {
  mode: 'polling-screenshots';
  running: boolean;
  /** Target frames per second requested by the current policy (active vs idle). */
  targetFps: number;
  /** Frames per second measured over the last 10 seconds. */
  measuredFps: number;
  avgLatencyMs: number;
  lastFrameAt: number | null;
  pausedReason: string | null;
  viewers: number;
  consecutiveErrors: number;
  lastError: string | null;
}

export interface ScreenElement {
  /** Short id the AI uses to reference the element (e1, e2, …). */
  id: string;
  label: string;
  /** Tap point in window points. */
  x: number;
  y: number;
  kind?: string;
  confidence?: number;
}

export interface ScreenDescription {
  capturedAt: number;
  elements: ScreenElement[];
  /** Raw text returned by describe_screen, kept for the AI and for diagnostics. */
  rawText: string;
  /** Optional grid-overlaid screenshot from describe_screen (base64, never persisted by default). */
  imageBase64: string | null;
  imageMimeType: string | null;
  geometry: WindowGeometry | null;
  /** Hash of the visible element labels; used for change and loop detection. */
  fingerprint: string;
}
