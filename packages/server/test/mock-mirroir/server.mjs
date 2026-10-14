#!/usr/bin/env node
// Mock Mirroir MCP server: a CI stand-in for mirroir-mcp 0.40.1 (no iPhone,
// no iPhone Mirroring, no macOS permissions needed). NEVER used in production.
//
// Reproduces the behaviour iPhone AI depends on, as verified in Mirroir's
// Swift source and against the live binary:
//  • stdio JSON-RPC, serverInfo {name:"mirroir-mcp", version:"0.40.1"},
//    capabilities {tools:{}}; requests are handled strictly one at a time and
//    notifications/cancelled has no effect on a running tool.
//  • The 38 tool definitions captured from the real binary (tools.json).
//  • Project-local permissions: <cwd>/.mirroir-mcp/permissions.json is read
//    ONCE at startup; read-only tools are always listed, mutating tools are
//    hidden unless allowed (fail-closed), denials are isError results with
//    Mirroir's exact texts, blockedApps is checked by launch_app only.
//  • Exact output formats (em dashes U+2014, Int-truncated coordinates,
//    element lines sorted by y) and isError semantics for every input tool.
//  • SIGTERM/SIGINT/SIGHUP release a held touch and exit 143/130/129; stdin
//    EOF lets the running tool finish, then exits 0.
//
// Test control (MirroirManager spawns Mirroir with a minimal environment, so
// the mock is steered through files in its working directory, re-read on
// every call):
//   <cwd>/mock-state.json   { mirroring, window, pos, scale, screen, resetSeq,
//                             crashOnCall, slowMs, screenRecording, ocrFailure,
//                             resumeDelayMs, timeScale }   (see README.md)
//   <cwd>/mock-calls.jsonl  every tools/call received ({t,name,args}), plus
//                             lifecycle lines ({event:...} / {signal:...})
//   <cwd>/mock-phone.json   persisted simulated phone state
//
// The user's real ~/.mirroir-mcp is never read or written: the global config
// fallback only exists when `--global-config-dir <dir>` is passed.

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { DESIGN_H, DESIGN_W, matchLabel, pausedOverlayElements, Phone } from './phone.mjs';
import { renderFrame } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();
const CONTROL_FILE = path.join(CWD, 'mock-state.json');
const CALLS_FILE = path.join(CWD, 'mock-calls.jsonl');
const PHONE_FILE = path.join(CWD, 'mock-phone.json');
const LOCAL_CONFIG_DIR = path.join(CWD, '.mirroir-mcp');
const TARGET = 'iphone';
const CAPABILITIES = '[appSwitcher, home, menuActions, spotlight]';

/** PermissionPolicy.swift:93-106 — always allowed, never hidden. */
const READONLY_TOOLS = [
  'screenshot',
  'describe_screen',
  'start_recording',
  'stop_recording',
  'get_orientation',
  'status',
  'check_health',
  'list_targets',
  'list_skills',
  'get_skill',
  'calibrate_component',
  'classify_screen',
];

/** PermissionPolicy.swift:109-136 — need an explicit allow. */
const MUTATING_TOOLS = [
  'tap',
  'swipe',
  'drag',
  'type_text',
  'press_key',
  'long_press',
  'double_tap',
  'touch',
  'pinch',
  'rotate',
  'hold_keys',
  'shake',
  'launch_app',
  'open_url',
  'press_home',
  'press_app_switcher',
  'press_back',
  'spotlight',
  'scroll_to',
  'reset_app',
  'measure',
  'set_network',
  'switch_target',
  'record_step',
  'save_compiled',
  'generate_skill',
];

const TOOL_DEFINITIONS = JSON.parse(readFileSync(path.join(HERE, 'tools.json'), 'utf8'));

// ───────────────────────────── utilities ─────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : null);
const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const trunc = (v) => Math.trunc(v);
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (s) => [...segmenter.segment(s)].map((g) => g.segment);

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Mirroir's DebugLog.persist line format: "[<tag> HH:mm:ss.SSS] message". */
function persist(tag, message) {
  process.stderr.write(`[${tag} ${stamp()}] ${message}\n`);
}

function logLine(entry) {
  try {
    appendFileSync(CALLS_FILE, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
  } catch {
    // The log is a test aid; never let it break the protocol.
  }
}

const ok = (text) => ({ content: [{ type: 'text', text }], isError: false });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

function crash(message) {
  process.stderr.write(`${message}\n`);
  logLine({ event: 'crash', message });
  // Swift runtime traps exit with SIGTRAP (133) and skip every cleanup handler.
  process.exit(133);
}

// ───────────────────────────── arguments ─────────────────────────────

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const GLOBAL_CONFIG_DIR = argValue('--global-config-dir');

// ───────────────────────────── permissions ─────────────────────────────

const SWIFT_DECODE_ERROR = 'The data couldn’t be read because it isn’t in the correct format.';

function validatePermissionConfig(raw) {
  if (!isObject(raw)) throw new Error(SWIFT_DECODE_ERROR);
  const stringArray = (v) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'));
  for (const key of ['allow', 'deny', 'blockedApps', 'skipElements', 'confirmElements']) {
    if (!stringArray(raw[key])) throw new Error(SWIFT_DECODE_ERROR);
  }
  if (raw.perApp !== undefined) {
    if (!isObject(raw.perApp)) throw new Error(SWIFT_DECODE_ERROR);
    for (const rules of Object.values(raw.perApp)) {
      if (!isObject(rules) || !stringArray(rules.allow) || !stringArray(rules.deny)) throw new Error(SWIFT_DECODE_ERROR);
    }
  }
  return raw;
}

/** First file that exists wins and is used whole (no merge); a parse failure fails closed. */
function loadPermissionConfig() {
  const candidates = [path.join(LOCAL_CONFIG_DIR, 'permissions.json')];
  if (GLOBAL_CONFIG_DIR) candidates.push(path.join(GLOBAL_CONFIG_DIR, 'permissions.json'));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      return validatePermissionConfig(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      const reason = err instanceof SyntaxError ? SWIFT_DECODE_ERROR : err instanceof Error ? err.message : String(err);
      process.stderr.write(`Warning: Failed to parse permissions config at ${file}: ${reason}\n`);
      return null;
    }
  }
  return null;
}

function loadSettings() {
  const candidates = [path.join(LOCAL_CONFIG_DIR, 'settings.json')];
  if (GLOBAL_CONFIG_DIR) candidates.push(path.join(GLOBAL_CONFIG_DIR, 'settings.json'));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (isObject(parsed)) return parsed;
      process.stderr.write(`Warning: settings.json at ${file} is not a JSON object\n`);
    } catch (err) {
      process.stderr.write(`Warning: Failed to parse settings.json at ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return {};
  }
  return {};
}

// Read once at startup and never reloaded (exactly like Mirroir).
const PERMISSIONS = loadPermissionConfig();
const SETTINGS = loadSettings();

const DENIAL = {
  explicit: (name) =>
    `Tool '${name}' requires explicit permission. Use --dangerously-skip-permissions or configure ~/.mirroir-mcp/permissions.json.`,
  denyList: (name) =>
    `Tool '${name}' is blocked by deny list in permissions config. Remove it from the deny list in ~/.mirroir-mcp/permissions.json to allow it.`,
  notAllowed: (name) =>
    `Tool '${name}' is not in the allow list. Add it to the allow list in ~/.mirroir-mcp/permissions.json or use --dangerously-skip-permissions.`,
};

/** PermissionPolicy.checkTool precedence: readonly → deny → allow "*" → allow → fail closed. */
function checkTool(name) {
  const lower = name.toLowerCase();
  if (READONLY_TOOLS.includes(lower)) return { allowed: true, reason: null };
  if (!PERMISSIONS) return { allowed: false, reason: DENIAL.explicit(name) };
  if ((PERMISSIONS.deny ?? []).some((d) => d.toLowerCase() === lower)) return { allowed: false, reason: DENIAL.denyList(name) };
  if (PERMISSIONS.allow) {
    if (PERMISSIONS.allow.includes('*')) return { allowed: true, reason: null };
    if (PERMISSIONS.allow.some((a) => a.toLowerCase() === lower)) return { allowed: true, reason: null };
    return { allowed: false, reason: DENIAL.notAllowed(name) };
  }
  return { allowed: false, reason: DENIAL.explicit(name) };
}

function isAppBlocked(name) {
  const lower = name.toLowerCase();
  return (PERMISSIONS?.blockedApps ?? []).some((app) => app.toLowerCase() === lower);
}

// ───────────────────────────── test control ─────────────────────────────

const MIRRORING_STATES = new Set(['connected', 'paused', 'not_running', 'no_window']);

function readControl() {
  let raw = {};
  try {
    if (existsSync(CONTROL_FILE)) raw = JSON.parse(readFileSync(CONTROL_FILE, 'utf8'));
  } catch (err) {
    persist('mock', `Warning: could not parse mock-state.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(raw)) raw = {};
  const mirroring = MIRRORING_STATES.has(raw.mirroring) ? raw.mirroring : 'connected';
  const win = /^(\d+)x(\d+)$/.exec(typeof raw.window === 'string' ? raw.window : '') ?? [null, '410', '898'];
  const pos = /^(-?\d+),\s*(-?\d+)$/.exec(typeof raw.pos === 'string' ? raw.pos : '') ?? [null, '1200', '80'];
  const w = Number(win[1]);
  const h = Number(win[2]);
  return {
    mirroring,
    win: { w, h, x: Number(pos[1]), y: Number(pos[2]), orientation: h > w ? 'portrait' : 'landscape' },
    scale: num(raw.scale) && raw.scale > 0 ? raw.scale : 2,
    screen: str(raw.screen),
    resetSeq: raw.resetSeq ?? null,
    crashOnCall: str(raw.crashOnCall),
    slowMs: isObject(raw.slowMs) ? raw.slowMs : {},
    screenRecording: raw.screenRecording === 'denied' ? 'denied' : 'granted',
    ocrFailure: raw.ocrFailure === true,
    resumeDelayMs: num(raw.resumeDelayMs) ?? 2000,
    // 1 = real-world input timings; the default keeps CI fast; 0 = instant.
    timeScale: num(raw.timeScale) ?? 0.25,
  };
}

// ───────────────────────────── simulated device ─────────────────────────────

const phone = Phone.load(PHONE_FILE);

/** Persistent touch (touch tool). Lives in process memory only: a restart releases it, like Mirroir. */
const touch = { held: false, x: 0, y: 0, startX: 0, startY: 0, window: null, lastActivity: 0, releasedReason: null };
const TOUCH_WATCHDOG_MS = 30000;

function savePhone() {
  try {
    phone.save(PHONE_FILE);
  } catch (err) {
    persist('mock', `Warning: could not save mock-phone.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function applyDirective(control) {
  if (!control.screen) return;
  const directive = `${control.screen}#${control.resetSeq ?? ''}`;
  if (phone.state.directive === directive) return;
  if (!Phone.isValidScreen(control.screen)) {
    persist('mock', `Warning: unknown screen '${control.screen}' in mock-state.json`);
    return;
  }
  phone.applyDirective(control.screen);
  phone.state.directive = directive;
  savePhone();
}

const toWindow = (win, e) => ({ x: trunc((e.x * win.w) / DESIGN_W), y: trunc((e.y * win.h) / DESIGN_H) });
const toDesign = (win, x, y) => ({ x: (x * DESIGN_W) / win.w, y: (y * DESIGN_H) / win.h });

function onScreenElements(control) {
  return control.mirroring === 'paused' ? pausedOverlayElements() : phone.visibleElements();
}

function ocrTexts(control, elements = onScreenElements(control)) {
  return elements
    .filter((e) => e.kind === 'text' && e.label)
    .map((e) => ({ label: e.label, statusBar: Boolean(e.statusBar), ...toWindow(control.win, e) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

function renderPng(control, { grid }) {
  const elements = onScreenElements(control);
  const { png } = renderFrame({
    widthPt: control.win.w,
    heightPt: control.win.h,
    scale: control.scale,
    designW: DESIGN_W,
    designH: DESIGN_H,
    sceneKey: control.mirroring === 'paused' ? 'paused-overlay' : phone.screenId,
    elements,
    focusField: control.mirroring === 'paused' ? null : phone.state.focus,
    grid,
  });
  return png.toString('base64');
}

const imageBlock = (data) => ({ type: 'image', data, mimeType: 'image/png' });

function describeText(control) {
  const elements = onScreenElements(control);
  const texts = ocrTexts(control, elements);
  const icons = elements
    .filter((e) => e.kind === 'icon')
    .map((e) => ({ ...toWindow(control.win, e), size: trunc((e.size * control.win.w) / DESIGN_W) }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const lines = ['Screen elements (tap coordinates in points):'];
  if (control.ocrFailure) {
    lines.push(
      '(OCR FAILED — text recognition did not run: Vision text recognition failed: The operation couldn’t be completed. (mock OCR failure))',
    );
    lines.push('Any icons and hints below come from the non-OCR path; the text layer is missing, not empty.');
  } else if (texts.length === 0) {
    lines.push('(no text detected)');
  } else {
    for (const t of texts) lines.push(`- "${t.label}" at (${t.x}, ${t.y})`);
  }
  if (icons.length > 0) {
    lines.push('', 'Unlabeled icons (estimated positions):');
    for (const i of icons) lines.push(`- Icon at (${i.x}, ${i.y}), ~${i.size}x${i.size}pt`);
  }
  const hints = [];
  if (!control.ocrFailure && texts.some((t) => t.label.startsWith('<') && t.y < control.win.h * 0.2)) {
    hints.push('Back navigation: "<" detected — tap it to go back.');
  }
  const tabBar = control.mirroring === 'paused' ? 0 : phone.layout().tabBar;
  if (!control.ocrFailure && tabBar > 0) {
    hints.push(`Tab bar: ${tabBar} items detected in the bottom band — tap one to switch sections.`);
  }
  if (hints.length > 0) {
    lines.push('', 'Hints:');
    for (const hint of hints) lines.push(`- ${hint}`);
  }
  const count = control.ocrFailure ? 0 : texts.length;
  lines.push('', `_meta: ocr_time_ms=${60 + count * 3} recognition_level=accurate element_count=${count}${control.ocrFailure ? ' ocr_status=failed' : ''}`);
  return lines.join('\n');
}

// ───────────────────────────── state & preamble errors ─────────────────────────────

const STATE_ERRORS = {
  paused: `Target '${TARGET}' is paused. Unlock iPhone or click Resume in the mirroring window.`,
  not_running: `Target '${TARGET}' is not running. Launch iPhone Mirroring first.`,
  no_window: `Target '${TARGET}' window not found. Is the app running?`,
};

/** ensureConnected for pointing/keyboard tools (no Resume button on a locked phone → fails at once). */
function inputStateError(control) {
  return control.mirroring === 'connected' ? null : STATE_ERRORS[control.mirroring];
}

function boundsError(control, x, y) {
  const { w, h } = control.win;
  if (x < 0 || y < 0 || x > w || y > h) {
    return `Coordinates (${trunc(x)}, ${trunc(y)}) are outside the '${TARGET}' window (${w}x${h}). x must be 0-${w}, y must be 0-${h}.`;
  }
  return null;
}

function checkWatchdog() {
  if (touch.held && Date.now() - touch.lastActivity > TOUCH_WATCHDOG_MS) {
    touch.held = false;
    touch.releasedReason = 'watchdog lifted it after 30s without a touch call';
  }
}

function heldRefusal(tag) {
  checkWatchdog();
  if (!touch.held) return null;
  return `A touch is held at (${trunc(touch.x)}, ${trunc(touch.y)}), so ${tag} is refused: a click would lift it. Finish it with touch(action:"end") or release it with touch(action:"cancel") first.`;
}

/** preparePointingInput order: held touch → ensureConnected → window → bounds. */
function pointerPreamble(control, tag, points) {
  return (
    heldRefusal(tag) ??
    inputStateError(control) ??
    points.map(([x, y]) => boundsError(control, x, y)).find((e) => e !== null) ??
    null
  );
}

function cursorModeError(args) {
  if (args.cursor_mode === undefined) return null;
  if (args.cursor_mode === 'direct' || args.cursor_mode === 'preserving') return null;
  return `Invalid cursor_mode '${String(args.cursor_mode)}'. Must be 'direct' or 'preserving'.`;
}

const ACCENTED = new Set([...'éèêëàâäáãåùûüúìîïíòôöóõñçÇÉÈÊËÀÂÄÁÙÛÜÚÌÎÏÍÒÔÖÓÑ']);
/** Characters CGKeyMap can type directly; anything else sends the WHOLE string through the clipboard. */
function isMappable(g) {
  if (g === '\r\n') return true;
  return /^[\x20-\x7e\n\r\t]$/.test(g) || ACCENTED.has(g);
}

function swipeEffect(control, fromX, fromY, toX, toY) {
  const from = toDesign(control.win, fromX, fromY);
  const to = toDesign(control.win, toX, toY);
  const dy = from.y - to.y;
  const dx = from.x - to.x;
  if (Math.abs(dy) < Math.abs(dx)) return;
  if (phone.screenId === 'home' && dy < -60 && from.y < DESIGN_H * 0.8) {
    phone.openSpotlight();
    return;
  }
  phone.scrollBy(dy);
}

// ───────────────────────────── tools ─────────────────────────────

const OPEN_URL_REFUSAL =
  'open_url is not supported for iPhone Mirroring targets. Keyboard shortcuts (Cmd+L) do not work through iPhone Mirroring. To navigate in Safari: launch Safari, tap the address bar, use type_text to enter the URL, then press_key(key: "return").';

const notSimulated = (name) => fail(`${name} is not simulated by the mock Mirroir server`);

function skillFiles() {
  const root = path.join(LOCAL_CONFIG_DIR, 'skills');
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else if (entry.endsWith('.md') || entry.endsWith('.yaml')) out.push({ full, rel: path.relative(root, full) });
    }
  };
  walk(root);
  return { root, files: out };
}

function frontMatter(content, key) {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(content);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

const TOOLS = {
  async status(_args, c) {
    switch (c.mirroring) {
      case 'connected':
        return ok(`Connected — mirroring active (window: ${c.win.w}x${c.win.h}, pos=(${c.win.x},${c.win.y}), ${c.win.orientation})`);
      case 'paused':
        return ok('Paused — connection paused, can resume');
      case 'not_running':
        return ok(`Not running — '${TARGET}' is not open`);
      default:
        return ok('No window — app is running but no mirroring window found');
    }
  },

  async get_orientation(_args, c) {
    if (c.mirroring === 'not_running' || c.mirroring === 'no_window') {
      return fail(`Cannot determine orientation. Is target '${TARGET}' running?`);
    }
    return ok(`Orientation: ${c.win.orientation} (window: ${c.win.w}x${c.win.h})`);
  },

  async list_targets(_args, c) {
    const state = { connected: 'connected', paused: 'paused', not_running: 'notRunning', no_window: 'noWindow' }[c.mirroring];
    const size = c.mirroring === 'connected' || c.mirroring === 'paused' ? `${c.win.w}x${c.win.h}` : 'no window';
    return ok(`- ${TARGET} (active): ${state} (${size}) ${CAPABILITIES}`);
  },

  async check_health(_args, c) {
    const lines = [];
    lines.push(c.mirroring === 'not_running' ? `[FAIL] '${TARGET}' process is not running` : `[ok] '${TARGET}' process is running`);
    lines.push(
      {
        connected: `[ok] '${TARGET}' connected (window: ${c.win.w}x${c.win.h})`,
        paused: `[WARN] '${TARGET}' is paused — click the window to resume`,
        no_window: `[FAIL] '${TARGET}' running but no window found`,
        not_running: `[FAIL] '${TARGET}' not running`,
      }[c.mirroring],
    );
    const captureOk = c.screenRecording === 'granted' && (c.mirroring === 'connected' || c.mirroring === 'paused');
    lines.push(captureOk ? '[ok] Screen capture working (42 ms)' : '[FAIL] Screen capture failed — grant Screen Recording permission in System Settings');
    lines.push('[ok] Text recognition working (85 ms)');
    const header = lines.every((l) => l.startsWith('[ok]')) ? 'All checks passed' : 'Issues detected';
    return ok(`${header}\n\n${lines.join('\n')}`);
  },

  async screenshot(args, c) {
    if (c.mirroring === 'not_running') return fail(`Target '${TARGET}' is not running`);
    if (c.mirroring === 'no_window' || c.screenRecording === 'denied') {
      return fail(`Failed to capture screenshot. Is the '${TARGET}' window visible?`);
    }
    const settle = num(args.settle_ms);
    // UInt32(max(0, settle_ms)) * 1000 traps for values ≥ 4,294,968 (a real Mirroir crash).
    if (settle !== null && settle >= 4294968) crash('Fatal error: Not enough bits to represent the passed value');
    if (c.mirroring === 'paused') await sleep(c.resumeDelayMs);
    // Settled capture (default): returns once two consecutive 60 ms frames match.
    if (settle === null || settle > 0) await sleep(60);
    return { content: [imageBlock(renderPng(c, { grid: false }))], isError: false };
  },

  async describe_screen(args, c) {
    if (c.mirroring === 'not_running') return fail(`Target '${TARGET}' is not running`);
    if (c.mirroring === 'no_window' || c.screenRecording === 'denied') {
      return fail(`Failed to capture/analyze screen. Is the '${TARGET}' window visible?`);
    }
    if (c.mirroring === 'paused') await sleep(c.resumeDelayMs);
    const omit = typeof args.omit_screenshot === 'boolean' ? args.omit_screenshot : SETTINGS.describeScreenOmitScreenshot === true;

    if (args.scroll === true && c.mirroring === 'connected') {
      // "Read-only" full-page mode really swipes the phone (up to 10 times) and never scrolls back.
      const seen = new Map();
      const collect = () => {
        let added = 0;
        for (const t of ocrTexts(c)) {
          if (t.statusBar || seen.has(t.label)) continue;
          seen.set(t.label, t);
          added += 1;
        }
        return added;
      };
      collect();
      let scrolls = 0;
      let total = 0;
      for (let i = 0; i < 10; i += 1) {
        const before = phone.scrollOffset();
        if (!phone.scrollBy(DESIGN_H * 0.45)) break;
        scrolls += 1;
        total += phone.scrollOffset() - before;
        await sleep(800 * c.timeScale);
        if (collect() === 0) break;
      }
      savePhone();
      const items = [...seen.values()].sort((a, b) => a.y - b.y || a.x - b.x);
      const lines = ['Screen elements (page-absolute tap coordinates in points):'];
      if (items.length === 0) lines.push('(no text detected)');
      for (const t of items) lines.push(`- "${t.label}" at (${t.x}, ${t.y})`);
      lines.push('', `_meta: scroll_count=${scrolls} total_offset=${trunc((total * c.win.h) / DESIGN_H)} element_count=${items.length}`);
      const content = [{ type: 'text', text: lines.join('\n') }];
      if (!omit) content.push(imageBlock(renderPng(c, { grid: true })));
      return { content, isError: false };
    }

    const content = [{ type: 'text', text: describeText(c) }];
    if (!omit) content.push(imageBlock(renderPng(c, { grid: true })));
    return { content, isError: false };
  },

  async tap(args, c) {
    const x = num(args.x);
    const y = num(args.y);
    if (x === null || y === null) return fail('Missing required parameters: x, y (numbers)');
    const cursor = cursorModeError(args);
    if (cursor) return fail(cursor);
    const err = pointerPreamble(c, 'tap', [[x, y]]);
    if (err) return fail(err);
    await sleep(50 * c.timeScale);
    const d = toDesign(c.win, x, y);
    phone.tap(d.x, d.y);
    savePhone();
    return ok(`Tapped at (${trunc(x)}, ${trunc(y)})`);
  },

  async double_tap(args, c) {
    const x = num(args.x);
    const y = num(args.y);
    if (x === null || y === null) return fail('Missing required parameters: x, y (numbers)');
    const cursor = cursorModeError(args);
    if (cursor) return fail(cursor);
    const err = pointerPreamble(c, 'doubleTap', [[x, y]]);
    if (err) return fail(err);
    await sleep(150 * c.timeScale);
    const d = toDesign(c.win, x, y);
    phone.tap(d.x, d.y);
    savePhone();
    return ok(`Double-tapped at (${trunc(x)}, ${trunc(y)})`);
  },

  async long_press(args, c) {
    const x = num(args.x);
    const y = num(args.y);
    if (x === null || y === null) return fail('Missing required parameters: x, y (numbers)');
    const cursor = cursorModeError(args);
    if (cursor) return fail(cursor);
    const err = pointerPreamble(c, 'longPress', [[x, y]]);
    if (err) return fail(err);
    const duration = num(args.duration_ms) ?? 500;
    await sleep(Math.min(60000, Math.max(1, duration)) * c.timeScale);
    return ok(`Long pressed at (${trunc(x)}, ${trunc(y)}) for ${trunc(duration)}ms`);
  },

  async swipe(args, c) {
    const [fx, fy, tx, ty] = [num(args.from_x), num(args.from_y), num(args.to_x), num(args.to_y)];
    if (fx === null || fy === null || tx === null || ty === null) {
      return fail('Missing required parameters: from_x, from_y, to_x, to_y (numbers)');
    }
    const cursor = cursorModeError(args);
    if (cursor) return fail(cursor);
    const err = pointerPreamble(c, 'swipe', [
      [fx, fy],
      [tx, ty],
    ]);
    if (err) return fail(err);
    const duration = num(args.duration_ms) ?? 300;
    await sleep((250 + Math.min(60000, Math.max(1, duration))) * c.timeScale);
    swipeEffect(c, fx, fy, tx, ty);
    savePhone();
    return ok(`Swiped from (${trunc(fx)},${trunc(fy)}) to (${trunc(tx)},${trunc(ty)})`);
  },

  async drag(args, c) {
    const [fx, fy, tx, ty] = [num(args.from_x), num(args.from_y), num(args.to_x), num(args.to_y)];
    if (fx === null || fy === null || tx === null || ty === null) {
      return fail('Missing required parameters: from_x, from_y, to_x, to_y (numbers)');
    }
    const cursor = cursorModeError(args);
    if (cursor) return fail(cursor);
    const err = pointerPreamble(c, 'drag', [
      [fx, fy],
      [tx, ty],
    ]);
    if (err) return fail(err);
    const duration = num(args.duration_ms) ?? 1000;
    await sleep(Math.min(60000, Math.max(1, duration)) * c.timeScale);
    swipeEffect(c, fx, fy, tx, ty);
    savePhone();
    return ok(`Dragged from (${trunc(fx)},${trunc(fy)}) to (${trunc(tx)},${trunc(ty)}) over ${trunc(duration)}ms`);
  },

  async type_text(args, c) {
    const value = str(args.text);
    if (value === null) return fail('Missing required parameter: text (string)');
    const err = inputStateError(c);
    if (err) return fail(err);
    const chars = graphemes(value);
    const unmappable = chars.filter((g) => !isMappable(g));
    if (unmappable.length > 0) {
      // The whole string goes through NSPasteboard + Cmd+V (Universal Clipboard).
      await sleep(1750 * c.timeScale);
      phone.insertText(value);
      savePhone();
      return ok(
        `Typed ${chars.length} characters. Warning: ${unmappable.length} character(s) have no key mapping and were sent through the clipboard with Cmd+V. That path needs Universal Clipboard: Handoff enabled on both the Mac and the iPhone, Bluetooth and Wi-Fi on, and both signed into the same iCloud account. If the field is still empty, Handoff is the thing to check — verify before relying on this text.`,
      );
    }
    for (const g of chars) {
      if (g === '\n' || g === '\r' || g === '\r\n') phone.pressReturn();
      else if (g !== '\t') phone.insertText(g);
    }
    await sleep(23 * chars.length * c.timeScale);
    savePhone();
    return ok(`Typed ${chars.length} characters`);
  },

  async press_key(args, c) {
    const key = str(args.key);
    if (key === null) return fail('Missing required parameter: key (string)');
    const err = inputStateError(c);
    if (err) return fail(err);
    const named = ['return', 'escape', 'tab', 'delete', 'space', 'up', 'down', 'left', 'right'];
    if (!named.includes(key) && [...key].length !== 1) {
      return fail(`Unknown key '${key}'. Supported: delete, down, escape, left, return, right, space, tab, up, or a single character.`);
    }
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map(String) : [];
    for (const m of modifiers) {
      if (!['shift', 'command', 'option', 'control'].includes(m.toLowerCase())) {
        return fail(`Unknown modifier '${m}'. Supported: shift, command, option, control.`);
      }
    }
    const lowered = modifiers.map((m) => m.toLowerCase());
    if (key === 'return') phone.pressReturn();
    else if (key === 'delete') phone.deleteBackward();
    else if (key === 'space') phone.insertText(' ');
    else if (key === 'escape') {
      if (phone.screenId === 'spotlight') phone.goHome();
      else phone.state.focus = null;
    } else if (!named.includes(key) && !lowered.some((m) => m !== 'shift')) {
      // Only the keycode is sent: 'A' types 'a' unless shift is passed as a modifier.
      phone.insertText(lowered.includes('shift') ? key.toUpperCase() : key.toLowerCase());
    }
    await sleep(20 * c.timeScale);
    savePhone();
    return ok(modifiers.length ? `Pressed ${[...modifiers, key].join('+')}` : `Pressed ${key}`);
  },

  async press_home(_args, c) {
    if (c.mirroring === 'not_running') return fail(`Failed to press Home. Is '${TARGET}' running?`);
    // AX menu press: "succeeds" even when paused, but the phone only reacts when connected.
    if (c.mirroring === 'connected') {
      phone.goHome();
      savePhone();
    }
    return ok('Pressed Home — navigated to home screen');
  },

  async press_app_switcher(_args, c) {
    if (c.mirroring === 'not_running') return fail(`Failed to open App Switcher. Is '${TARGET}' running?`);
    if (c.mirroring === 'connected') {
      phone.openAppSwitcher();
      savePhone();
    }
    return ok('Opened App Switcher');
  },

  async spotlight(_args, c) {
    if (c.mirroring === 'not_running') return fail(`Failed to open Spotlight. Is '${TARGET}' running?`);
    if (c.mirroring === 'connected') {
      phone.openSpotlight();
      savePhone();
    }
    return ok('Opened Spotlight search');
  },

  async press_back(_args, c) {
    if (c.mirroring === 'not_running') return fail(`Target '${TARGET}' is not running`);
    if (c.mirroring === 'no_window') return fail(`Failed to capture/analyze screen. Is the '${TARGET}' window visible?`);
    if (c.mirroring === 'paused') await sleep(c.resumeDelayMs);
    // OCR the "<" chevron, else blind-tap the canonical fallback point. The tap's
    // own error (held touch, paused, bounds) is discarded: always "success".
    if (c.mirroring === 'connected' && !heldRefusal('tap')) {
      const chevron = phone.visibleElements().find((e) => e.kind === 'text' && e.label.startsWith('<') && e.y < DESIGN_H * 0.2);
      if (chevron) phone.tap(chevron.x, chevron.y);
      else if (c.win.orientation === 'portrait') phone.tap(DESIGN_W * 0.112, DESIGN_H * 0.135);
      else phone.tap(DESIGN_W * 0.057, DESIGN_H * 0.1);
      savePhone();
    }
    await sleep(500 * c.timeScale);
    return ok('Pressed back (OCR chevron or canonical fallback)');
  },

  async launch_app(args, c) {
    const name = str(args.name);
    if (name === null) return fail('Missing required parameter: name (string)');
    if (isAppBlocked(name)) {
      return fail(`App '${name}' is blocked by permissions config. Remove it from blockedApps in ~/.mirroir-mcp/permissions.json to allow launching it.`);
    }
    const err = inputStateError(c);
    if (err) return fail(err);
    // Spotlight → type the name → Return → OCR confirmation (≈3.5 s on a real phone).
    phone.openSpotlight();
    await sleep(800 * c.timeScale);
    phone.insertText(name);
    await sleep((1000 + 23 * name.length) * c.timeScale);
    phone.pressReturn();
    await sleep(1200 * c.timeScale);
    savePhone();
    if (phone.screenId === 'spotlight') {
      return fail(
        `Spotlight is still open after searching '${name}', so no app launched. Use the exact name shown under the home-screen icon, or call press_home to close Spotlight.`,
      );
    }
    return ok(`Launched '${name}' via Spotlight`);
  },

  async open_url(args) {
    if (str(args.url) === null) return fail('Missing required parameter: url (string)');
    return fail(OPEN_URL_REFUSAL);
  },

  async scroll_to(args, c) {
    const label = str(args.label);
    if (!label) return fail('Missing required parameter: label (string)');
    const direction = args.direction === undefined ? 'up' : String(args.direction);
    if (!['up', 'down', 'left', 'right'].includes(direction)) return fail(`Unknown direction: ${direction}. Use up/down/left/right.`);
    const maxScrolls = int(args.max_scrolls) ?? 10;
    if (c.mirroring === 'not_running' || c.mirroring === 'no_window') return fail('Could not get window info for scroll');
    const labels = () => ocrTexts(c).filter((t) => !t.statusBar).map((t) => t.label);
    if (matchLabel(labels(), label)) return ok(`'${label}' is already visible on screen`);
    const step = DESIGN_H * 0.3 * (direction === 'up' ? 1 : direction === 'down' ? -1 : 0);
    for (let n = 1; n <= maxScrolls; n += 1) {
      const err = pointerPreamble(c, 'swipe', []);
      if (err) return fail(`Swipe failed: ${err}`);
      const before = JSON.stringify([...labels()].sort());
      if (step !== 0) phone.scrollBy(step);
      await sleep(800 * c.timeScale);
      savePhone();
      if (matchLabel(labels(), label)) return ok(`Found '${label}' after ${n} scroll(s)`);
      if (JSON.stringify([...labels()].sort()) === before) {
        return fail(`'${label}' not found — scroll exhausted after ${n} scroll(s)`);
      }
    }
    return fail(`'${label}' not found after ${maxScrolls} scroll(s)`);
  },

  async touch(args, c) {
    const action = str(args.action);
    if (action === null) return fail('Missing required parameter: action (begin | move | end | cancel)');
    checkWatchdog();
    const noTouch = () => {
      const reason = touch.releasedReason;
      touch.releasedReason = null;
      return fail(`No touch is held. Start one with touch(action:"begin").${reason ? ` The previous touch was released: ${reason}.` : ''}`);
    };
    switch (action) {
      case 'begin': {
        const x = num(args.x);
        const y = num(args.y);
        if (x === null || y === null) return fail('touch(action:"begin") requires x, y (numbers)');
        if (touch.held) {
          return fail(
            `A touch is already held at (${trunc(touch.x)}, ${trunc(touch.y)}). Move it with touch(action:"move"), lift it with touch(action:"end"), or release it with touch(action:"cancel").`,
          );
        }
        const err = inputStateError(c) ?? boundsError(c, x, y);
        if (err) return fail(err);
        Object.assign(touch, { held: true, x, y, startX: x, startY: y, window: `${c.win.w}x${c.win.h}`, lastActivity: Date.now(), releasedReason: null });
        return ok(`Touch began at (${trunc(x)}, ${trunc(y)}) and is held. End it with touch(action:"end").`);
      }
      case 'move': {
        const x = num(args.x);
        const y = num(args.y);
        if (x === null || y === null) return fail('touch(action:"move") requires x, y (numbers)');
        if (args.duration_ms !== undefined) {
          const d = args.duration_ms;
          if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 5000) {
            const shown = typeof d === 'number' && Number.isFinite(d) ? String(trunc(d)) : 'a value that is not an integer';
            return fail(`touch move duration_ms must be between 1 and 5000 (got ${shown}). Split a longer slide into several moves.`);
          }
        }
        if (!touch.held) return noTouch();
        const current = `${c.win.w}x${c.win.h}`;
        if (touch.window !== current) {
          const previous = touch.window;
          touch.held = false;
          return fail(
            `The touch was released: the target window changed from ${previous} to ${current} while the touch was held (the iPhone rotated, or Mirroring was resized or restarted). Its coordinates no longer name the same spot on the iPhone. Start a new touch with coordinates from the current window.`,
          );
        }
        await sleep((num(args.duration_ms) ?? 100) * c.timeScale);
        Object.assign(touch, { x, y, lastActivity: Date.now() });
        return ok(`Touch moved to (${trunc(x)}, ${trunc(y)}) and is held.`);
      }
      case 'end': {
        if (!touch.held) return noTouch();
        const { x, y, startX, startY } = touch;
        touch.held = false;
        if (c.mirroring === 'connected') {
          if (Math.hypot(x - startX, y - startY) < 10) {
            const d = toDesign(c.win, x, y);
            phone.tap(d.x, d.y);
          } else {
            swipeEffect(c, startX, startY, x, y);
          }
          savePhone();
        }
        return ok(`Touch ended at (${trunc(x)}, ${trunc(y)}).`);
      }
      case 'cancel': {
        if (!touch.held) return ok('Touch cancelled: no touch was held; the left button was released anyway.');
        touch.held = false;
        return ok(`Touch cancelled: released at (${trunc(touch.x)}, ${trunc(touch.y)}).`);
      }
      default:
        return fail(`Invalid action '${action}'. Must be one of: begin, move, end, cancel.`);
    }
  },

  async pinch(args, c) {
    if (num(args.x) === null || num(args.y) === null || num(args.scale) === null) {
      return fail('Missing required parameters: x, y, scale (numbers)');
    }
    void c;
    return fail(
      'pinch needs a Mac with a built-in trackpad or a Magic Trackpad: iPhone Mirroring only accepts pinch and rotate events sent from a multitouch trackpad, and none was found in the IORegistry.',
    );
  },

  async rotate(args) {
    if (num(args.x) === null || num(args.y) === null || num(args.degrees) === null) {
      return fail('Missing required parameters: x, y, degrees (numbers)');
    }
    return fail(
      'rotate needs a Mac with a built-in trackpad or a Magic Trackpad: iPhone Mirroring only accepts pinch and rotate events sent from a multitouch trackpad, and none was found in the IORegistry.',
    );
  },

  async hold_keys(_args, c) {
    const err = heldRefusal('hold_keys') ?? inputStateError(c);
    if (err) return fail(err);
    return fail(`hold_keys refused: '${TARGET}' is not the frontmost app, so the keys would go to another Mac app. Bring the mirroring window to the front and retry.`);
  },

  async shake(_args, c) {
    const err = inputStateError(c);
    if (err) return fail(err);
    return fail('CGEvent shake failed');
  },

  async reset_app(args) {
    const name = str(args.name);
    if (name === null) return fail('Missing required parameter: name (string)');
    return fail(`Cannot locate '${name}' card in App Switcher unambiguously — refusing to drag (would risk quitting the wrong app)`);
  },

  async switch_target(args) {
    const target = str(args.target);
    if (target === null) return fail('Missing required parameter: target (string)');
    if (target !== TARGET) return fail(`Unknown target '${target}'. Available: ${TARGET}`);
    return ok(`Switched active target to '${TARGET}'`);
  },

  async start_recording() {
    return fail('Recording failed to start (exit code 1). Check Screen Recording permission in System Preferences > Privacy & Security.');
  },

  async stop_recording() {
    return fail('No recording in progress');
  },

  async classify_screen() {
    return fail('No component definitions found to classify against');
  },

  async list_skills() {
    const { root, files } = skillFiles();
    if (files.length === 0) {
      return ok(`No skills found.\nPlace .yaml or .md files in ${root}/ or ~/.mirroir-mcp/skills/`);
    }
    const lines = files.map(({ full, rel }) => {
      const content = readFileSync(full, 'utf8');
      const name = frontMatter(content, 'name') ?? rel.replace(/\.(md|yaml)$/, '');
      const description = frontMatter(content, 'description') ?? '(no description)';
      return `- ${name}: ${description}  [local]`;
    });
    return ok(lines.join('\n'));
  },

  async get_skill(args) {
    const name = str(args.name);
    if (name === null) return fail('Missing required parameter: name (string)');
    const { root, files } = skillFiles();
    const stem = name.replace(/\.(md|yaml)$/, '');
    const match =
      files.find((f) => f.rel === `${stem}.md`) ??
      files.find((f) => f.rel === `${stem}.yaml`) ??
      files.find((f) => path.basename(f.rel).replace(/\.(md|yaml)$/, '') === path.basename(stem));
    if (!match) {
      if (files.length === 0) {
        return fail(`Skill '${name}' not found. No skills installed.\nSearched: ${root}\nInstall skills: https://github.com/jfarcand/mirroir-skills`);
      }
      return fail(`Skill '${name}' not found. Available skills:\n${files.map((f) => `  - ${f.rel.replace(/\.(md|yaml)$/, '')}`).join('\n')}`);
    }
    return ok(`${readFileSync(match.full, 'utf8')}\n\n[Not compiled — use record_step after each step to compile]`);
  },

  async save_compiled() {
    return fail('No steps recorded. Call record_step before save_compiled.');
  },

  async calibrate_component() {
    return notSimulated('calibrate_component');
  },
  async measure() {
    return notSimulated('measure');
  },
  async set_network() {
    return notSimulated('set_network');
  },
  async record_step() {
    return notSimulated('record_step');
  },
  async generate_skill() {
    return notSimulated('generate_skill');
  },
};

// ───────────────────────────── MCP wiring ─────────────────────────────

const known = new Set(TOOL_DEFINITIONS.map((t) => t.name));
for (const name of [...READONLY_TOOLS, ...MUTATING_TOOLS]) {
  if (!known.has(name) || !TOOLS[name]) throw new Error(`mock Mirroir: tool ${name} is not fully defined`);
}

/** Mirroir handles one request at a time: later requests wait in the pipe. */
let lane = Promise.resolve();
function serial(fn) {
  const run = lane.then(fn, fn);
  lane = run.catch(() => undefined);
  return run;
}

function visibleTools() {
  const tools = TOOL_DEFINITIONS.filter((t) => checkTool(t.name).allowed);
  // Mirroir keeps tools in a Swift dictionary: the order changes between runs.
  for (let i = tools.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [tools[i], tools[j]] = [tools[j], tools[i]];
  }
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

async function callTool(name, rawArgs) {
  const args = isObject(rawArgs) ? rawArgs : {};
  logLine({ name, args });
  if (!known.has(name)) {
    const error = new Error(`Unknown tool: ${name}`);
    error.code = -32602;
    throw error;
  }
  const permission = checkTool(name);
  if (!permission.allowed) return fail(permission.reason);

  const control = readControl();
  if (control.crashOnCall === name) crash('Fatal error: Unexpectedly found nil while implicitly unwrapping an Optional value');
  const slow = num(control.slowMs[name]);
  if (slow) await sleep(slow);
  applyDirective(control);
  if (name !== 'list_targets' && name !== 'switch_target' && typeof args.target === 'string' && args.target !== TARGET) {
    return fail(`Unknown target '${args.target}'`);
  }
  return TOOLS[name](args, control);
}

const server = new Server({ name: 'mirroir-mcp', version: '0.40.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => serial(async () => ({ tools: visibleTools() })));
server.setRequestHandler(CallToolRequestSchema, (request) =>
  serial(() => callTool(request.params.name, request.params.arguments)),
);

// ───────────────────────────── lifecycle ─────────────────────────────

for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
]) {
  process.on(signal, () => {
    if (touch.held) {
      touch.held = false;
      persist('touch', 'released held touch (signal)');
    }
    logLine({ signal });
    process.exit(code);
  });
}

process.stdin.on('end', () => {
  // A tool that is already running finishes first, then the process exits 0.
  void lane.then(() => {
    logLine({ event: 'exit', reason: 'stdin closed' });
    process.exit(0);
  });
});

persist('startup', 'version: mock-mirroir (CI stand-in for mirroir-mcp 0.40.1)');
if (!PERMISSIONS) {
  persist('startup', 'Permission mode: fail-closed (readonly tools only)');
} else {
  persist('startup', 'Permission mode: config-based (~/.mirroir-mcp/permissions.json)');
  process.stderr.write(`  allow: ${JSON.stringify(PERMISSIONS.allow ?? [])}\n`);
  process.stderr.write(`  deny: ${JSON.stringify(PERMISSIONS.deny ?? [])}\n`);
  process.stderr.write(`  blockedApps: ${JSON.stringify(PERMISSIONS.blockedApps ?? [])}\n`);
}
const hidden = MUTATING_TOOLS.filter((t) => !checkTool(t).allowed);
if (hidden.length > 0) process.stderr.write(`WARNING: hidden from tools/list: ${JSON.stringify(hidden)}\n`);
persist('startup', `Targets: ["${TARGET}"] (active: ${TARGET})`);
logLine({ event: 'start', pid: process.pid, permissions: PERMISSIONS ? 'config' : 'fail-closed' });

await server.connect(new StdioServerTransport());
