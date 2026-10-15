# iPhone AI — Local API

The backend (Node.js, Fastify) serves the UI, a JSON REST API under `/api`, an event
WebSocket at `/ws` and a binary live-frame WebSocket at `/ws/screen`. Types referenced
below live in `packages/shared/src`.

## Security model

- Binds **127.0.0.1 only** by default (random free port in the desktop app; `47823` in development).
- Every request's `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence). The remote listener accepts only its configured address.
- Every `/api/*` route (except `GET /api/health` and `POST /api/auth/remote-login`) requires a session cookie `iai_session` (HttpOnly, SameSite=Strict, Path=/).
- Every state-changing request (`POST`/`PUT`/`DELETE`) must carry header `x-iphone-ai: 1` (CSRF defence) and, when present, an `Origin` matching the host.
- WebSocket upgrades (`/ws` and `/ws/screen`) require the session cookie and a matching `Origin`.
- Sessions:
  - **desktop**: the Tauri shell generates a random token (env `IPHONE_AI_DESKTOP_TOKEN`) and opens `/auth/desktop?token=…`; the backend sets the cookie and redirects to `/`.
  - **local-browser**: `POST /api/auth/browser-link` (desktop session only) creates a one-time code valid 2 minutes; `GET /auth/local?code=…` exchanges it for a cookie.
  - **remote**: only on the opt-in remote listener; `POST /api/auth/remote-login {passcode, deviceName}`; the passcode is stored as a scrypt hash; sessions are revocable and expire.
- Remote sessions are view-only unless `remote.allowRemoteControl` is on.

Errors are JSON: `{ "error": { "code": string, "message": string } }` with an HTTP status
(400 validation, 401 unauthenticated, 403 forbidden/policy, 404, 409 conflict/state, 412 precondition such as missing permission, 502 Mirroir tool failure, 503 Mirroir unavailable).

## Endpoints

### Auth & bootstrap
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, version, listener: 'local' \| 'remote' }` (no auth; `listener` names the listener that answered, so the UI can offer the passcode sign-in on the remote one before it has a session) |
| GET | `/auth/desktop?token=` | — | 302 → `/` + cookie |
| GET | `/auth/local?code=` | — | 302 → `/` + cookie |
| POST | `/api/auth/remote-login` | `{ passcode, deviceName? }` | `{ ok: true }` + cookie (remote listener only; errors: 401 `invalid_passcode`, 403 `remote_not_configured`, 429 `rate_limited` with a `Retry-After` header in seconds) |
| POST | `/api/auth/logout` | — | 204 |
| GET | `/api/auth/session` | — | `{ id, kind, canControl, remote }` |
| POST | `/api/auth/browser-link` | `{ open?: boolean }` | `{ url }` (desktop session only) |
| GET | `/api/bootstrap` | — | `{ status: DeviceStatus, settings: AppSettings, stream: StreamStats, pendingApprovals: ApprovalRequest[], activeTask: AgentTask \| null, activeRun: WorkflowRun \| null, session, version }` |

### Connection & diagnostics
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/status` | — | `DeviceStatus` |
| POST | `/api/connection/refresh` | — | `DeviceStatus` (re-reads `status` and runs `mirroir doctor`) |
| POST | `/api/connection/restart` | — | `DeviceStatus` (restarts the Mirroir MCP server) |
| POST | `/api/connection/open-mirroring` | — | `{ opened: boolean }` |
| POST | `/api/connection/check-health` | — | `{ ok, items: HealthCheckItem[], raw }` (Mirroir `check_health`; user-initiated only) |
| GET | `/api/connection/doctor` | — | `{ checks: { name, status, detail, fix_hint? }[] }` |
| GET | `/api/connection/tools` | — | `McpToolInfo[]` |
| GET | `/api/connection/stderr` | — | `string[]` (last Mirroir stderr lines) |
| POST | `/api/connection/open-settings` | `{ pane: 'screen-recording' \| 'accessibility' \| 'automation' }` | `{ opened: boolean }` |
| GET | `/api/diagnostics/info` | — | `{ version, node, platform, arch, dataDir, mirroirBinary, mirroirVersion }` |
| GET | `/api/diagnostics/export` | — | sanitized JSON download |

### Screen
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/screen/frame/latest` | — | The newest frame from either source: `image/png` (polled Mirroir screenshot) or `image/jpeg` (live ScreenCaptureKit frame). Headers `x-frame-seq` and `x-frame-source: mirroir-screenshot \| screencapturekit`; 404 if no frame. Both sources share one sequence, so a higher seq is always newer. |
| POST | `/api/screen/capture` | `{ settleMs?: number, resume?: boolean }` | `FrameMeta` (user-initiated; `resume` lets Mirroir press Resume when paused) |
| POST | `/api/screen/describe` | — | `{ elements: ScreenElement[], rawText, fingerprint, geometry }` |
| GET | `/api/screen/stream` | — | `StreamStats` (see [Live view](#live-view-polling-and-screencapturekit)) |
| GET | `/api/screenshots/:id` | — | image (AI step / workflow screenshots) |

### Control & safety
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/control/action` | `ManualActionRequest` | `ActionResult` |
| POST | `/api/control/stop` | `{ reason?: string }` | `DeviceStatus` |
| POST | `/api/control/rearm` | — | `DeviceStatus` |
| PUT | `/api/control/mode` | `{ mode: ControlMode }` | `AppSettings` |
| PUT | `/api/control/manual` | `{ enabled: boolean }` | `AppSettings` |
| GET | `/api/approvals` | `?status=pending\|recent` | `ApprovalRequest[]` |
| POST | `/api/approvals/:id` | `{ decision: 'approved'\|'rejected', note? }` | `ApprovalRequest` |

### AI assistant
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/conversations` | — | `Conversation[]` |
| POST | `/api/conversations` | `{ title? }` | `Conversation` |
| DELETE | `/api/conversations/:id` | — | 204 |
| POST | `/api/conversations/:id/clear` | — | 204 |
| GET | `/api/conversations/:id/messages` | — | `ChatMessage[]` |
| GET | `/api/conversations/:id/tasks` | — | `AgentTask[]` |
| POST | `/api/conversations/:id/messages` | `StartTaskRequest` | `{ message: ChatMessage, task: AgentTask }` |
| GET | `/api/tasks/active` | — | `AgentTask \| null` |
| GET | `/api/tasks/:id` | — | `{ task: AgentTask, steps: AgentStep[] }` |
| POST | `/api/tasks/:id/pause` · `/resume` · `/cancel` | — | `AgentTask` |

### AI providers
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/providers` | — | `ProviderConfig[]` |
| POST | `/api/providers` | `ProviderConfig` (new, kind `openai-compatible`) | `AppSettings` |
| PUT | `/api/providers/:id` | `ProviderConfig` | `AppSettings` |
| DELETE | `/api/providers/:id` | — | `AppSettings` (custom providers only) |
| PUT | `/api/providers/:id/secret` | `{ apiKey }` | `{ hasApiKey: true }` (stored in Keychain) |
| DELETE | `/api/providers/:id/secret` | — | `{ hasApiKey: false }` |
| POST | `/api/providers/:id/test` | — | `ProviderTestResult` |
| GET | `/api/providers/:id/models` | — | `string[]` |
| GET | `/api/providers/claude-code/status` | — | `ClaudeCodeStatus` |
| PUT | `/api/providers/active` | `{ providerId }` | `AppSettings` |

### Automations
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/workflows` | — | `Workflow[]` |
| POST | `/api/workflows` | `WorkflowInput` | `Workflow` |
| GET/PUT/DELETE | `/api/workflows/:id` | `WorkflowInput` (PUT) | `Workflow` / 204 |
| POST | `/api/workflows/:id/run` | — | `WorkflowRun` |
| GET | `/api/workflows/:id/runs` | — | `WorkflowRun[]` |
| POST | `/api/workflows/:id/export-skill` | — | `{ path, markdown }` |
| POST | `/api/workflows/suggest` | `{ goal, providerId? }` | `WorkflowSuggestion` |
| GET | `/api/workflow-runs` | `?limit=` | `WorkflowRun[]` |
| GET | `/api/workflow-runs/:id` | — | `WorkflowRun` |
| POST | `/api/workflow-runs/:id/pause` · `/resume` · `/stop` | — | `WorkflowRun` |
| POST | `/api/workflow-runs/:id/retry` | `{ fromFailedStep: boolean }` | `WorkflowRun` |
| GET | `/api/recorder` | — | `RecorderStatus` |
| POST | `/api/recorder/start` | `{ name }` | `RecorderStatus` |
| POST | `/api/recorder/stop` | `{ save: boolean }` | `Workflow \| null` |

### Activity, settings, privacy, remote
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/activity` | `ActivityQuery` (query string; lists comma-separated) | `ActivityEvent[]` |
| GET | `/api/activity/export` | `?format=json\|csv` + filters | sanitized download |
| DELETE | `/api/activity` | — | `{ deleted }` |
| GET | `/api/settings` | — | `AppSettings` |
| PUT | `/api/settings` | `SettingsPatch` | `AppSettings` |
| POST | `/api/privacy/delete` | `{ activity?, conversations?, screenshots?, approvals? }` | `{ deleted: Record<string, number> }` |
| GET | `/api/remote` | — | `{ settings: RemoteSettings, listening, url \| null, addresses: NetworkAddress[] }` |
| PUT | `/api/remote/passcode` | `{ passcode }` | `{ passcodeSet: true }` |
| GET | `/api/remote/sessions` | — | `RemoteSessionInfo[]` |
| DELETE | `/api/remote/sessions/:id` | — | 204 |
| POST | `/api/remote/sessions/revoke-all` | — | `{ revoked }` |

## WebSocket `/ws`

Server → client: JSON `ServerEvent` (see `packages/shared/src/events.ts`). The first
message is `hello`. Polled screenshots are announced with `{ type: 'frame', meta }`; the
UI then loads `/api/screen/frame/latest?seq=<seq>`. Live ScreenCaptureKit frames are not
announced here — they arrive on `/ws/screen`. `stream_stats` events carry `StreamStats`.

Client → server: `ClientEvent`:
- `{ type: 'viewer', visible, interactive }` — drives screenshot polling (paused when no viewer is visible) and live capture.
- `{ type: 'activity_ping' }` — user interaction; keeps the active frame rate.
- `{ type: 'ping', t }` — keep-alive.

## WebSocket `/ws/screen`

Binary live frames from the ScreenCaptureKit capture helper. Same rules as `/ws`: session
cookie, matching `Origin`, `Host` check; any authenticated session may view (remote
view-only sessions included). Opening it does not start capture — the `/ws` `viewer`
messages do. Clients send nothing (pings/messages only prove liveness).

Each server → client message is **binary**:

```
[4-byte big-endian uint32 H][H bytes UTF-8 JSON LiveFrameHeader][JPEG bytes]
```

`LiveFrameHeader` (`packages/shared/src/device.ts`) is a `FrameMeta` with:

| Field | Meaning |
|---|---|
| `seq` | Frame sequence, shared with polled screenshots (higher = newer) |
| `capturedAt` | Epoch ms when ScreenCaptureKit captured the frame |
| `receivedAt` | Epoch ms when the backend received it |
| `latencyMs` | `receivedAt - capturedAt` |
| `widthPx`, `heightPx` | JPEG size (long edge ≤ 1600 px) |
| `mimeType` | `'image/jpeg'` |
| `pxPerPt` | JPEG pixels per window point (`widthPx / window width in pt`) |
| `geometry` | `WindowGeometry`, **only** when the captured window size (pt) equals Mirroir's current status geometry; otherwise `null` (do not derive touch coordinates from such a frame) |
| `source` | `'screencapturekit'` |

Behaviour:
- The latest frame is sent immediately on connect, then every new frame.
- Per-connection backpressure: a frame is skipped (never queued) while the socket has more than 1.5 MB buffered.
- Remote sessions receive at most 10 frames per second; local sessions get the helper's rate (`connection.screenshot.liveFps`).

## Live view: polling and ScreenCaptureKit

Two frame sources feed the viewer:

1. **Live capture** (`mode: 'live-screencapturekit'`): the bundled helper `iphone-ai-capture`
   (path from env `IPHONE_AI_CAPTURE_BIN`, set by the desktop app; in development
   `src-tauri/binaries/iphone-ai-capture-<arch>-apple-darwin` when present; never picked
   up implicitly in mock mode) streams the iPhone Mirroring window as JPEG over its
   stdout. It never touches Mirroir, so Mirroir's single serial lane stays free for actions.
   It runs while a viewer is visible **or** an AI task / workflow holds control, live capture
   is enabled (`connection.screenshot.liveCapture`), Screen Recording is confirmed and iPhone
   Mirroring is running (connected **or paused** — ScreenCaptureKit has no side effects). It
   stops 10 s after the last of these goes false (immediately when switched off). Errors,
   crashes, a missing first frame (3 s) or a stream that stays silent while polled
   screenshots show the screen changing restart it with backoff (1 s doubling to 30 s;
   60 s after a Screen Recording denial).
2. **Polling** (`mode: 'polling-screenshots'`): Mirroir `screenshot` calls at
   `activeFps`/`idleFps`, only with a visible viewer (or AI control), Screen Recording
   confirmed and Mirroring connected.

Polling pauses with `pausedReason: 'Live capture active'` while live frames are actually
arriving (one within the last 2 s) and resumes on its own when they stop. ScreenCaptureKit
normally delivers frames only when the window content changes, so on a still screen polling
may resume until the next change (not yet measured on the real device). `StreamStats`:

| Field | Meaning |
|---|---|
| `mode` | `'live-screencapturekit'` only while live frames arrive; otherwise `'polling-screenshots'` |
| `running`, `targetFps`, `measuredFps`, `avgLatencyMs` | Of the source in charge (live: helper fps, frames received over 10 s, capture → backend latency) |
| `lastFrameAt` | Newest frame from either source |
| `pausedReason` | Why polling is paused (`'Live capture active'`, `'No visible viewer'`, …) |
| `liveAvailable` | A capture helper is installed and live capture is enabled |
| `liveError` | Why live frames are not arriving (helper missing, permission, crash, waiting for the window); `null` while live or when nothing is wrong |
| `viewers`, `consecutiveErrors`, `lastError` | Visible viewers; polling errors |

The backend log records `Live capture started (ScreenCaptureKit, WxH px, N fps)`,
`Live capture unavailable: <reason>` and, every 60 s while running,
`Live capture stats: fps=…, avgLatencyMs=…, frames=…`.

## Settings notes

- `connection.screenshot.liveCapture` (default `true`) and `liveFps` (default 30, 5–60).
  Both are optional in a `PUT /api/settings` patch: a `screenshot` object without them keeps
  the current values (the nested object is merged).
- `ai.settleDelayMs` defaults to 450 ms (was 900). On first start of this version, a stored
  `settleDelayMs` of exactly 900 becomes 450 and a stored `connection.requestTimeoutMs` of
  exactly 60000 becomes 30000; customized values are kept, and the migration runs once.

## AI gestures

The AI `swipe` tool, workflow swipe steps and the Live viewer all send Mirroir `swipe` (a
synthesized trackpad scroll; Mirroir `drag` is a pointer click-drag that iOS scroll views
ignore), paced at 460 pt/s by `@iphone-ai/shared` `swipe.ts`: just under the 500 pt/s at
which Mirroir adds a ~1.4 s momentum tail, so the feed snaps to the nearest page at the lift
and has settled when Mirroir returns. The swipe is centred on the screen with travel
`short | medium | long` = 25 / 45 / 70 % of the screen dimension (default `long`, which
pages feeds), staying ≥ 60 pt from the top and bottom edges and ≥ 24 pt from the sides. The
allowed-AI-tools setting governs it through its `swipe` entry. Optional `times` (1–10) and
`interval_ms` (300–800, default 300) repeat the swipe; every repetition is policy-checked and
counted as an action, one approval covers the batch in Assisted Control, and one observation
follows the last swipe. In the viewer, a drag released while moving at ≥ 0.5 pt/ms (measured
over its last 100 ms) is a flick and sends the `long` swipe in the flick's direction; a drag
that stops before release replays its own start and end points; arrow keys send the `long`
swipe.
