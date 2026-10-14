# Mock Mirroir MCP server (CI stand-in)

`server.mjs` is a **test double** for [mirroir-mcp](https://github.com/jfarcand/mirroir-mcp)
0.40.1, the MCP server iPhone AI uses to drive a physical iPhone through Apple's
iPhone Mirroring. It lets the backend test suite run in CI and on machines with
no iPhone, no iPhone Mirroring session and no macOS Screen Recording /
Accessibility grants.

It is **never** used by the app in production, and passing tests against it does
not prove anything about the real device. The real-device acceptance tests are
separate: `test/device/real-device.test.ts`, skipped unless
`IPHONE_AI_DEVICE_TESTS=1` (`pnpm test:device`). They only read from the real
binary (status, orientation, targets, doctor, and a screenshot/describe only
when Screen Recording is granted and Mirroring is connected) and never send input.

## What it reproduces

Everything here was taken from Mirroir's Swift source and checked against the live
binary (see the research notes referenced in `docs/ARCHITECTURE.md`):

- **Protocol**: stdio JSON-RPC via the official MCP SDK's low-level `Server`;
  `serverInfo {name: "mirroir-mcp", version: "0.40.1"}`; capabilities
  `{tools: {}}`; requests are handled **one at a time** (a slow tool blocks
  everything behind it) and `notifications/cancelled` does not stop a running tool.
- **Tools**: `tools.json` is the exact `tools/list` catalogue (38 tools: names,
  descriptions, input schemas) captured from the real 0.40.1 binary. The list
  order is shuffled on every call, as Mirroir's dictionary order is.
- **Permissions** (`PermissionPolicy.swift`): `<cwd>/.mirroir-mcp/permissions.json`
  is read **once at startup**. Read-only tools are always listed and allowed;
  mutating tools are hidden from `tools/list` unless allowed; precedence is
  read-only → `deny` → `allow: ["*"]` → `allow` → fail closed. Denials are
  `isError` results with Mirroir's exact texts (they print the hard-coded
  `~/.mirroir-mcp/permissions.json` path, like the real server). A malformed
  file prints `Warning: Failed to parse permissions config at …` and fails
  closed. `blockedApps` (exact, case-insensitive) is checked by `launch_app` only.
  Unknown tool names are a JSON-RPC `-32602 "Unknown tool: X"` error.
- **Output formats**: `status`, `get_orientation`, `list_targets`,
  `check_health`, `describe_screen` (element lines sorted by y with
  Int-truncated coordinates, unescaped quotes inside labels, unlabeled icons,
  hints, `_meta`, OCR-failure and `(no text detected)` variants, the
  `scroll: true` page variant that really scrolls), the success and error texts
  of every input tool, U+2014 em dashes throughout.
- **Device-state errors**: paused / not running / no window produce Mirroir's
  input errors (`Target 'iphone' is paused. Unlock iPhone or click Resume in the
  mirroring window.` …); bounds errors; the held-touch refusal of pointer tools;
  `open_url` is always refused for the iPhone target; `press_back` always
  reports success (and blind-taps the fallback point when no `<` chevron is
  visible); `type_text` reports the Universal Clipboard warning for characters
  without a key mapping (Arabic, emoji, CJK).
- **Lifecycle**: SIGTERM / SIGINT / SIGHUP release a held touch and exit
  143 / 130 / 129; stdin EOF lets the running tool finish and exits 0;
  `screenshot settle_ms ≥ 4294968` crashes (exit 133) like Mirroir's UInt32
  overflow trap.
- **Screenshots**: real PNGs from a tiny encoder (`png.mjs`, zlib + CRC32):
  RGBA, the window at 2x (820x1796 for 410x898 pt) with transparent rounded
  corners, coloured blocks at every element. Frames are deterministic for a
  given screen + state (the clock is a fixed block), so tests can check
  dimensions and change detection. `describe_screen` images carry Mirroir's
  25 pt grid.

## The simulated phone (`phone.mjs`)

Screens: `home` (4x4 icon grid incl. Settings, Safari, Messages, Photos, Wallet,
Mail, Clock; a "Search" pill; 4 unlabeled dock icons), `settings` (long list:
Airplane Mode with a switch, Wi-Fi, Bluetooth, Cellular, Battery, General,
Notifications, Privacy & Security, Wallet & Apple Pay …), `wifi` (Wi-Fi switch
showing `On`/`Off`, networks), `wifi_password` (an auth prompt: "Enter
Password", `Enter the password for "Cafe Guest"`), `battery` (Battery
Percentage switch, `87%`), `notifications`, `general`, `detail:<Row>` sub-pages,
`safari` (address bar "Search or enter website name"), `messages` and
`conversation:<Name>` (with an unlabeled send button), `spotlight` (search field
and results), `app_switcher`, `app:<Name>` (generic apps; Photos and Clock have
tab bars), and `blank`.

Behaviour: taps hit-test elements (±25 pt, and full-width list rows);
`launch_app` goes through Spotlight (an unknown name leaves Spotlight open and
returns Mirroir's "Spotlight is still open …" error); `press_home`,
`press_back`, `press_app_switcher`, `spotlight`; vertical swipes / drags /
`scroll_to` scroll long lists; `type_text` appends to the focused field (Safari
address bar, Spotlight query, message draft, Wi-Fi password); `press_key return`
opens the Spotlight top hit, loads the Safari address or joins the Wi-Fi
network; toggles flip. Phone state is persisted to `<cwd>/mock-phone.json`, so
it survives a server restart like a real phone does (a held touch does not).

## Controlling it from tests

`MirroirManager` spawns Mirroir with a minimal environment (only HOME, LOGNAME,
PATH, SHELL, TERM, USER) and `cwd` = the app's Mirroir workspace, so the mock is
steered through files in its working directory, **re-read on every tool call**:

`<cwd>/mock-state.json` (all fields optional):

| field | default | meaning |
|---|---|---|
| `mirroring` | `"connected"` | `"connected"` \| `"paused"` \| `"not_running"` \| `"no_window"` — drives `status`, `list_targets`, `get_orientation`, `check_health` and the input errors |
| `window` | `"410x898"` | window size in points (`"WxH"`); layouts scale to it |
| `pos` | `"1200,80"` | window position reported by `status` |
| `scale` | `2` | backing scale of screenshots |
| `screen` | — | jump to a screen when this value (or `resetSeq`) changes, e.g. `"settings"`, `"wifi"`, `"app:Photos"` |
| `resetSeq` | — | change it to re-apply the same `screen` |
| `crashOnCall` | — | tool name: the server crashes (exit 133, no cleanup) when it is called |
| `slowMs` | `{}` | `{ "<tool>": ms }` delay before the tool runs (simulates a wedged call) |
| `screenRecording` | `"granted"` | `"denied"` makes captures fail like Mirroir without the grant |
| `ocrFailure` | `false` | `describe_screen` reports `(OCR FAILED — …)` |
| `resumeDelayMs` | `2000` | the unconditional 2 s wait of `screenshot`/`describe_screen`/`press_back` when paused |
| `timeScale` | `0.25` | multiplier for realistic input timings (1 = real-world, 0 = instant) |

`<cwd>/mock-calls.jsonl`: one JSON line per `tools/call` received
(`{"t":…, "name":"tap", "args":{…}}`, including denied calls), plus lifecycle
lines: `{"event":"start","pid":…}`, `{"event":"exit",…}`, `{"event":"crash",…}`
and `{"signal":"SIGTERM"}`.

`test/helpers/context.ts` wraps all of this (`writeMockState`, `readMockCalls`,
`readMockLog`).

## Deliberately not implemented

- The user's global `~/.mirroir-mcp` is never read or written. The global
  fallback for `permissions.json` / `settings.json` exists only when the mock is
  started with `--global-config-dir <dir>`.
- `--dangerously-skip-permissions` / `--yolo` are not supported.
- `sampling/createMessage`, the 2026-07-28 stateless protocol mode, recordings,
  component calibration, skill generation, `measure`, `set_network` and
  `record_step` return an `isError` result (`… is not simulated by the mock
  Mirroir server` where Mirroir's real text is unknown).
- No real input, screen capture or OCR happens: the mock never touches the
  Mac's pointer, keyboard, clipboard or windows.
