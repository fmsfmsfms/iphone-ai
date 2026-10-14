// Typed client for every REST endpoint in docs/API.md.
//
// - Same-origin cookies (`iai_session`) authenticate every call.
// - State-changing requests carry the CSRF header `x-iphone-ai: 1`.
// - Errors become `ApiError { status, code, message }`. A 401 notifies the
//   registered handler, which switches the UI to the "Session expired" screen.

import {
  API_PREFIX,
  CSRF_HEADER,
  type ActionResult,
  type ActivityEvent,
  type ActivityQuery,
  type AgentStep,
  type AgentTask,
  type AppSettings,
  type ApprovalRequest,
  type ChatMessage,
  type ControlMode,
  type Conversation,
  type DeviceStatus,
  type FrameMeta,
  type ManualActionRequest,
  type McpToolInfo,
  type ProviderConfig,
  type ProviderTestResult,
  type SettingsPatch,
  type StartTaskRequest,
  type StreamStats,
  type Workflow,
  type WorkflowInput,
  type WorkflowRun,
  type WorkflowSuggestion,
} from '@iphone-ai/shared';

import type {
  BootstrapResponse,
  ClaudeCodeStatus,
  DescribeResponse,
  DiagnosticsInfo,
  DoctorResponse,
  ExportSkillResponse,
  HealthCheckResponse,
  HealthResponse,
  PrivacyDeleteRequest,
  RecorderStatus,
  RemoteInfo,
  RemoteSessionInfo,
  SendMessageResponse,
  SessionInfo,
  SettingsPane,
} from './api-types';

export type * from './api-types';

/** Error returned by the backend (or synthesised for network failures). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when the backend could not be reached at all (or a proxy reported it down). */
  get isUnreachable(): boolean {
    return this.code === 'network' || this.code === 'bad_gateway';
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unexpected error';
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Registers the callback invoked whenever any request gets a 401. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface RequestOptions {
  signal?: AbortSignal;
  /** Do not trigger the session-expired handler on 401 (used by probes). */
  quiet401?: boolean;
}

function isErrorBody(value: unknown): value is { error: { code?: unknown; message?: unknown } } {
  return typeof value === 'object' && value !== null && 'error' in value && typeof (value as { error: unknown }).error === 'object';
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  if (isErrorBody(body) && body.error) {
    const code = typeof body.error.code === 'string' ? body.error.code : `http_${res.status}`;
    const message = typeof body.error.message === 'string' ? body.error.message : res.statusText || `HTTP ${res.status}`;
    return new ApiError(res.status, code, message);
  }
  // A non-JSON 5xx means a proxy (or nothing) answered instead of the backend.
  if (res.status >= 500) return new ApiError(res.status, 'bad_gateway', res.statusText || `HTTP ${res.status}`);
  return new ApiError(res.status, `http_${res.status}`, res.statusText || `HTTP ${res.status}`);
}

async function send(method: Method, path: string, body?: unknown, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'The iPhone AI service is not reachable.');
  }
  if (res.status === 401) {
    const error = await toApiError(res);
    if (!options.quiet401) unauthorizedHandler?.();
    throw error;
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

async function request<T>(method: Method, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const res = await send(method, path, body, options);
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    const text = await res.text();
    return (text.length ? text : undefined) as T;
  }
  return (await res.json()) as T;
}

/** Raw request helper for endpoints that return binary data. */
export async function fetchBlob(path: string, options?: RequestOptions): Promise<{ blob: Blob; headers: Headers }> {
  const res = await send('GET', path, undefined, options);
  return { blob: await res.blob(), headers: res.headers };
}

const get = <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options);
const post = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body ?? {}, options);
const put = <T>(path: string, body: unknown, options?: RequestOptions) => request<T>('PUT', path, body, options);
const del = <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options);

const enc = encodeURIComponent;
const A = API_PREFIX;

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

/** Serialises an ActivityQuery (lists are comma-separated). */
export function activityQueryString(q: ActivityQuery = {}): string {
  return query({
    categories: q.categories?.join(','),
    severity: q.severity?.join(','),
    actor: q.actor?.join(','),
    search: q.search,
    taskId: q.taskId,
    since: q.since,
    until: q.until,
    limit: q.limit,
    before: q.before,
  });
}

export const api = {
  health: (options?: RequestOptions) => get<HealthResponse>(`${A}/health`, options),
  bootstrap: (options?: RequestOptions) => get<BootstrapResponse>(`${A}/bootstrap`, options),
  status: () => get<DeviceStatus>(`${A}/status`),

  auth: {
    session: (options?: RequestOptions) => get<SessionInfo>(`${A}/auth/session`, options),
    logout: () => post<void>(`${A}/auth/logout`),
    browserLink: (open?: boolean) => post<{ url: string }>(`${A}/auth/browser-link`, open === undefined ? {} : { open }),
    remoteLogin: (passcode: string, deviceName?: string) =>
      post<{ ok: true }>(`${A}/auth/remote-login`, deviceName ? { passcode, deviceName } : { passcode }, { quiet401: true }),
  },

  connection: {
    refresh: () => post<DeviceStatus>(`${A}/connection/refresh`),
    restart: () => post<DeviceStatus>(`${A}/connection/restart`),
    openMirroring: () => post<{ opened: boolean }>(`${A}/connection/open-mirroring`),
    checkHealth: () => post<HealthCheckResponse>(`${A}/connection/check-health`),
    doctor: () => get<DoctorResponse>(`${A}/connection/doctor`),
    tools: () => get<McpToolInfo[]>(`${A}/connection/tools`),
    stderr: () => get<string[]>(`${A}/connection/stderr`),
    openSettings: (pane: SettingsPane) => post<{ opened: boolean }>(`${A}/connection/open-settings`, { pane }),
  },

  diagnostics: {
    info: () => get<DiagnosticsInfo>(`${A}/diagnostics/info`),
    /** URL for the sanitized diagnostics download (use as a link href). */
    exportUrl: () => `${A}/diagnostics/export`,
  },

  screen: {
    /** URL of the latest frame; `seq` only busts caches (the header `x-frame-seq` names the real frame). */
    latestFrameUrl: (seq?: number) => `${A}/screen/frame/latest${query({ seq })}`,
    capture: (body: { settleMs?: number; resume?: boolean } = {}) => post<FrameMeta>(`${A}/screen/capture`, body),
    describe: () => post<DescribeResponse>(`${A}/screen/describe`),
    stream: () => get<StreamStats>(`${A}/screen/stream`),
    screenshotUrl: (id: string) => `${A}/screenshots/${enc(id)}`,
  },

  control: {
    action: (req: ManualActionRequest) => post<ActionResult>(`${A}/control/action`, req),
    stop: (reason?: string) => post<DeviceStatus>(`${A}/control/stop`, reason ? { reason } : {}),
    rearm: () => post<DeviceStatus>(`${A}/control/rearm`),
    setMode: (mode: ControlMode) => put<AppSettings>(`${A}/control/mode`, { mode }),
    setManual: (enabled: boolean) => put<AppSettings>(`${A}/control/manual`, { enabled }),
  },

  approvals: {
    list: (status: 'pending' | 'recent' = 'pending') => get<ApprovalRequest[]>(`${A}/approvals${query({ status })}`),
    decide: (id: string, decision: 'approved' | 'rejected', note?: string) =>
      post<ApprovalRequest>(`${A}/approvals/${enc(id)}`, note ? { decision, note } : { decision }),
  },

  conversations: {
    list: () => get<Conversation[]>(`${A}/conversations`),
    create: (title?: string) => post<Conversation>(`${A}/conversations`, title ? { title } : {}),
    remove: (id: string) => del<void>(`${A}/conversations/${enc(id)}`),
    clear: (id: string) => post<void>(`${A}/conversations/${enc(id)}/clear`),
    messages: (id: string) => get<ChatMessage[]>(`${A}/conversations/${enc(id)}/messages`),
    tasks: (id: string) => get<AgentTask[]>(`${A}/conversations/${enc(id)}/tasks`),
    send: (id: string, body: StartTaskRequest) => post<SendMessageResponse>(`${A}/conversations/${enc(id)}/messages`, body),
  },

  tasks: {
    active: () => get<AgentTask | null>(`${A}/tasks/active`),
    get: (id: string) => get<{ task: AgentTask; steps: AgentStep[] }>(`${A}/tasks/${enc(id)}`),
    pause: (id: string) => post<AgentTask>(`${A}/tasks/${enc(id)}/pause`),
    resume: (id: string) => post<AgentTask>(`${A}/tasks/${enc(id)}/resume`),
    cancel: (id: string) => post<AgentTask>(`${A}/tasks/${enc(id)}/cancel`),
  },

  providers: {
    list: () => get<ProviderConfig[]>(`${A}/providers`),
    create: (provider: ProviderConfig) => post<AppSettings>(`${A}/providers`, provider),
    update: (provider: ProviderConfig) => put<AppSettings>(`${A}/providers/${enc(provider.id)}`, provider),
    remove: (id: string) => del<AppSettings>(`${A}/providers/${enc(id)}`),
    setSecret: (id: string, apiKey: string) => put<{ hasApiKey: true }>(`${A}/providers/${enc(id)}/secret`, { apiKey }),
    deleteSecret: (id: string) => del<{ hasApiKey: false }>(`${A}/providers/${enc(id)}/secret`),
    test: (id: string) => post<ProviderTestResult>(`${A}/providers/${enc(id)}/test`),
    models: (id: string) => get<string[]>(`${A}/providers/${enc(id)}/models`),
    claudeCodeStatus: () => get<ClaudeCodeStatus>(`${A}/providers/claude-code/status`),
    setActive: (providerId: string) => put<AppSettings>(`${A}/providers/active`, { providerId }),
  },

  workflows: {
    list: () => get<Workflow[]>(`${A}/workflows`),
    create: (input: WorkflowInput) => post<Workflow>(`${A}/workflows`, input),
    get: (id: string) => get<Workflow>(`${A}/workflows/${enc(id)}`),
    update: (id: string, input: WorkflowInput) => put<Workflow>(`${A}/workflows/${enc(id)}`, input),
    remove: (id: string) => del<void>(`${A}/workflows/${enc(id)}`),
    run: (id: string) => post<WorkflowRun>(`${A}/workflows/${enc(id)}/run`),
    runs: (id: string) => get<WorkflowRun[]>(`${A}/workflows/${enc(id)}/runs`),
    exportSkill: (id: string) => post<ExportSkillResponse>(`${A}/workflows/${enc(id)}/export-skill`),
    suggest: (goal: string, providerId?: string) =>
      post<WorkflowSuggestion>(`${A}/workflows/suggest`, providerId ? { goal, providerId } : { goal }),
  },

  workflowRuns: {
    list: (limit?: number) => get<WorkflowRun[]>(`${A}/workflow-runs${query({ limit })}`),
    get: (id: string) => get<WorkflowRun>(`${A}/workflow-runs/${enc(id)}`),
    pause: (id: string) => post<WorkflowRun>(`${A}/workflow-runs/${enc(id)}/pause`),
    resume: (id: string) => post<WorkflowRun>(`${A}/workflow-runs/${enc(id)}/resume`),
    stop: (id: string) => post<WorkflowRun>(`${A}/workflow-runs/${enc(id)}/stop`),
    retry: (id: string, fromFailedStep: boolean) => post<WorkflowRun>(`${A}/workflow-runs/${enc(id)}/retry`, { fromFailedStep }),
  },

  recorder: {
    status: () => get<RecorderStatus>(`${A}/recorder`),
    start: (name: string) => post<RecorderStatus>(`${A}/recorder/start`, { name }),
    stop: (save: boolean) => post<Workflow | null>(`${A}/recorder/stop`, { save }),
  },

  activity: {
    list: (q: ActivityQuery = {}) => get<ActivityEvent[]>(`${A}/activity${activityQueryString(q)}`),
    /** URL for a sanitized export download (use as a link href). */
    exportUrl: (format: 'json' | 'csv', q: ActivityQuery = {}) => {
      const qs = activityQueryString(q);
      return `${A}/activity/export${qs ? `${qs}&` : '?'}format=${format}`;
    },
    clear: () => del<{ deleted: number }>(`${A}/activity`),
  },

  settings: {
    get: () => get<AppSettings>(`${A}/settings`),
    update: (patch: SettingsPatch) => put<AppSettings>(`${A}/settings`, patch),
  },

  privacy: {
    delete: (body: PrivacyDeleteRequest) => post<{ deleted: Record<string, number> }>(`${A}/privacy/delete`, body),
  },

  remote: {
    get: () => get<RemoteInfo>(`${A}/remote`),
    setPasscode: (passcode: string) => put<{ passcodeSet: true }>(`${A}/remote/passcode`, { passcode }),
    sessions: () => get<RemoteSessionInfo[]>(`${A}/remote/sessions`),
    revokeSession: (id: string) => del<void>(`${A}/remote/sessions/${enc(id)}`),
    revokeAll: () => post<{ revoked: number }>(`${A}/remote/sessions/revoke-all`),
  },
} as const;

export type Api = typeof api;
