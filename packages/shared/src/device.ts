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

/** Where a frame came from: a polled Mirroir `screenshot` (PNG) or the ScreenCaptureKit live helper (JPEG). */
export type FrameSource = 'mirroir-screenshot' | 'screencapturekit';

/**
 * Metadata for one captured frame. Frames are either polled Mirroir
 * screenshots or JPEG frames from the ScreenCaptureKit live capture helper.
 * Both share one sequence space (a higher `seq` is always a newer frame).
 */
export interface FrameMeta {
  seq: number;
  capturedAt: number;
  /** Wall time the screenshot tool call took (live frames: capture → backend). */
  latencyMs: number;
  widthPx: number;
  heightPx: number;
  mimeType: string;
  /** Pixels per point (usually 2 on Retina). Null when geometry is unknown. */
  pxPerPt: number | null;
  /** Live frames: only set when the captured window size equals Mirroir's current status geometry. */
  geometry: WindowGeometry | null;
  source?: FrameSource;
  /** When the backend received the frame (live frames). */
  receivedAt?: number;
}

/**
 * Header of every binary message on the `/ws/screen` WebSocket:
 * `[4-byte big-endian uint32 H][H bytes UTF-8 JSON LiveFrameHeader][JPEG bytes]`.
 */
export type LiveFrameHeader = FrameMeta & {
  mimeType: 'image/jpeg';
  source: 'screencapturekit';
  receivedAt: number;
};

/** How the live viewer currently gets frames. */
export type StreamMode = 'polling-screenshots' | 'live-screencapturekit';

export interface StreamStats {
  /** 'live-screencapturekit' only while live frames are actually arriving (one within the last 2 s). */
  mode: StreamMode;
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
  /**
   * A ScreenCaptureKit capture helper is installed and live capture is enabled
   * in settings (false while it is turned off for this session because it made
   * Mirroir report iPhone Mirroring as paused; `liveError` then says so).
   */
  liveAvailable: boolean;
  /** Why live capture is not delivering (helper missing, permission, crash…); null when fine or not needed. */
  liveError: string | null;
}

/**
 * `liveError` while live capture is off for the session because it made
 * Mirroir report iPhone Mirroring as paused (the web shows a translation).
 */
export const LIVE_CONFLICT_ERROR =
  'Live view is off for this session: it made Mirroir report iPhone Mirroring as paused, which blocks control. The screen is updated with Mirroir screenshots instead. Turn Live view off and on again in Settings › iPhone Connection to retry.';

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
