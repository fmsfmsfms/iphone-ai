# iPhone AI — Local API

The backend (Node.js, Fastify) serves the UI, a JSON REST API under `/api`, and a
WebSocket at `/ws`. Types referenced below live in `packages/shared/src`.

## Security model

- Binds **127.0.0.1 only** by default (random free port in the desktop app; `47823` in development).
- Every request's `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence). The remote listener accepts only its configured address.
- Every `/api/*` route (except `GET /api/health` and `POST /api/auth/remote-login`) requires a session cookie `iai_session` (HttpOnly, SameSite=Strict, Path=/).
- Every state-changing request (`POST`/`PUT`/`DELETE`) must carry header `x-iphone-ai: 1` (CSRF defence) and, when present, an `Origin` matching the host.
- The WebSocket upgrade requires the session cookie and a matching `Origin`.
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
| GET | `/api/screen/frame/latest` | — | `image/png`, header `x-frame-seq`; 404 if no frame |
| POST | `/api/screen/capture` | `{ settleMs?: number, resume?: boolean }` | `FrameMeta` (user-initiated; `resume` lets Mirroir press Resume when paused) |
| POST | `/api/screen/describe` | — | `{ elements: ScreenElement[], rawText, fingerprint, geometry }` |
| GET | `/api/screen/stream` | — | `StreamStats` |
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
message is `hello`. Frames are announced with `{ type: 'frame', meta }`; the UI then
loads `/api/screen/frame/latest?seq=<seq>`.

Client → server: `ClientEvent`:
- `{ type: 'viewer', visible, interactive }` — drives screenshot polling (paused when no viewer is visible).
- `{ type: 'activity_ping' }` — user interaction; keeps the active frame rate.
- `{ type: 'ping', t }` — keep-alive.
