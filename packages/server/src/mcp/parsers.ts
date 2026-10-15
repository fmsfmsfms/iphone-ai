// Parsers for Mirroir MCP text outputs (mirroir-mcp 0.40.1).
//
// Mirroir returns human-readable text, not JSON. Formats were taken from the
// Swift source (InfoTools.swift, ScreenTools.swift, TargetTools.swift) and
// verified against the live binary. Dashes are U+2014 em dashes.

import { createHash } from 'node:crypto';

import type {
  HealthCheckItem,
  MirroringState,
  Orientation,
  ScreenElement,
  WindowGeometry,
} from '@iphone-ai/shared';

export interface ParsedStatus {
  state: MirroringState;
  geometry: { widthPt: number; heightPt: number; x: number | null; y: number | null; orientation: Orientation } | null;
  raw: string;
}

const STATUS_CONNECTED =
  /^Connected\s+\S+\s+mirroring active \(window:\s*(\d+)x(\d+),\s*pos=\((-?\d+),\s*(-?\d+)\),\s*(portrait|landscape)\)/i;

/** Parses the `status` tool text. */
export function parseStatus(text: string): ParsedStatus {
  const raw = text.trim();
  const connected = STATUS_CONNECTED.exec(raw);
  if (connected) {
    return {
      state: 'connected',
      raw,
      geometry: {
        widthPt: Number(connected[1]),
        heightPt: Number(connected[2]),
        x: Number(connected[3]),
        y: Number(connected[4]),
        orientation: connected[5]!.toLowerCase() as Orientation,
      },
    };
  }
  if (/^Connected\b/i.test(raw)) return { state: 'connected', raw, geometry: null };
  if (/^Paused\b/i.test(raw)) return { state: 'paused', raw, geometry: null };
  if (/^Not running\b/i.test(raw)) return { state: 'not_running', raw, geometry: null };
  if (/^No window\b/i.test(raw)) return { state: 'no_window', raw, geometry: null };
  return { state: 'error', raw, geometry: null };
}

/** Parses `get_orientation`: "Orientation: portrait (window: 355x782)". */
export function parseOrientation(text: string): { orientation: Orientation; widthPt: number; heightPt: number } | null {
  const m = /Orientation:\s*(portrait|landscape)\s*\(window:\s*(\d+)x(\d+)\)/i.exec(text);
  if (!m) return null;
  return { orientation: m[1]!.toLowerCase() as Orientation, widthPt: Number(m[2]), heightPt: Number(m[3]) };
}

export interface ParsedTarget {
  name: string;
  active: boolean;
  state: string;
  widthPt: number | null;
  heightPt: number | null;
  capabilities: string[];
}

/** Parses `list_targets`: "- iphone (active): paused (355x782) [appSwitcher, home, menuActions, spotlight]". */
export function parseTargets(text: string): ParsedTarget[] {
  const out: ParsedTarget[] = [];
  for (const line of text.split('\n')) {
    const m = /^-\s+(\S+?)( \(active\))?:\s+(\w+)\s+\((?:(\d+)x(\d+)|no window)\)\s*\[([^\]]*)\]/.exec(line.trim());
    if (!m) continue;
    out.push({
      name: m[1]!,
      active: Boolean(m[2]),
      state: m[3]!,
      widthPt: m[4] ? Number(m[4]) : null,
      heightPt: m[5] ? Number(m[5]) : null,
      capabilities: m[6]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return out;
}

export function geometryId(widthPt: number, heightPt: number): string {
  return `${widthPt}x${heightPt}`;
}

export function makeGeometry(widthPt: number, heightPt: number, orientation?: Orientation): WindowGeometry {
  return {
    widthPt,
    heightPt,
    orientation: orientation ?? (heightPt >= widthPt ? 'portrait' : 'landscape'),
    geometryId: geometryId(widthPt, heightPt),
    observedAt: Date.now(),
  };
}

export interface ParsedDescription {
  elements: ScreenElement[];
  icons: { x: number; y: number; sizePt: number }[];
  hints: string[];
  meta: Record<string, string>;
  ocrFailed: boolean;
  noText: boolean;
  scrolled: boolean;
}

const ELEMENT_LINE = /^- "(.*)" at \((-?\d+), (-?\d+)\)$/;
const ICON_LINE = /^- Icon at \((-?\d+), (-?\d+)\), ~(\d+)x(\d+)pt$/;

/** Parses the text block of `describe_screen`. Element ids are assigned in reading order (e1, e2, …). */
export function parseDescribeScreen(text: string): ParsedDescription {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const elements: ScreenElement[] = [];
  const icons: ParsedDescription['icons'] = [];
  const hints: string[] = [];
  const meta: Record<string, string> = {};
  let section: 'elements' | 'icons' | 'hints' | 'none' = 'none';
  let ocrFailed = false;
  let noText = false;
  let scrolled = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Screen elements')) {
      section = 'elements';
      scrolled = trimmed.includes('page-absolute');
      continue;
    }
    if (trimmed.startsWith('Unlabeled icons')) {
      section = 'icons';
      continue;
    }
    if (trimmed === 'Hints:') {
      section = 'hints';
      continue;
    }
    if (trimmed.startsWith('_meta:')) {
      for (const pair of trimmed.slice('_meta:'.length).trim().split(/\s+/)) {
        const eq = pair.indexOf('=');
        if (eq > 0) meta[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      if (meta.ocr_status === 'failed') ocrFailed = true;
      continue;
    }
    if (trimmed.startsWith('(OCR FAILED')) {
      ocrFailed = true;
      continue;
    }
    if (trimmed === '(no text detected)') {
      noText = true;
      continue;
    }
    if (!trimmed) continue;

    if (section === 'elements') {
      const m = ELEMENT_LINE.exec(trimmed);
      if (m) {
        elements.push({ id: `e${elements.length + 1}`, label: m[1]!, x: Number(m[2]), y: Number(m[3]), kind: 'text' });
      }
    } else if (section === 'icons') {
      const m = ICON_LINE.exec(trimmed);
      if (m) icons.push({ x: Number(m[1]), y: Number(m[2]), sizePt: Number(m[3]) });
    } else if (section === 'hints') {
      if (trimmed.startsWith('- ')) hints.push(trimmed.slice(2));
    }
  }

  // Unlabeled icons become addressable elements too (after text elements).
  for (const icon of icons) {
    elements.push({
      id: `e${elements.length + 1}`,
      label: '',
      x: icon.x,
      y: icon.y,
      kind: `icon ~${icon.sizePt}pt`,
    });
  }

  return { elements, icons, hints, meta, ocrFailed, noText, scrolled };
}

/** The status-bar clock as OCR reads it on a real iPhone: "3:16 M", "10:171", "13.17.X", "3,18 x". */
const STATUS_CLOCK = /^(\d{1,2})[:.,](\d{2})/;
/** A price that starts like a time ("1,249.00", "12.50 SAR", "9.99 $"): never the clock. */
const PRICE_LIKE = /^\d{1,2}[:.,]\d{2}\d?[.,]\d|\p{Sc}|#|\b(sar|sr|usd|aed|eur|gbp|kwd|qar|bhd|omr)\b|ر\s?\.\s?س|ريال|ریال/iu;
/** The clock carries at most a few stray glyphs ("3:16 M", "10:14 t's not": a caption merged in). */
const STATUS_CLOCK_MAX_LETTERS = 6;
/** The status bar lies in the top 12% of the window (y≈63 of the 785 pt iPhone Mirroring window). */
const STATUS_BAR_TOP_SHARE = 0.12;
/** The clock sits at the left of the status bar (x≈64–93 of the 356 pt window). */
const STATUS_CLOCK_LEFT_SHARE = 0.4;
/** Window size assumed when the caller does not know it (portrait iPhone Mirroring is ~356×785 pt). */
const STATUS_BAR_FALLBACK_HEIGHT_PT = 800;
const STATUS_BAR_FALLBACK_WIDTH_PT = 360;
/**
 * Half the height of the status-bar row. On the recorded device the clock,
 * signal and battery texts of one observation sit within 3 pt of each other.
 */
export const STATUS_BAR_HALF_ROW_PT = 6;

/** The y below which the status area (status bar, Dynamic Island) ends: the top 12% of the window. */
export function statusAreaBottom(heightPt?: number | null): number {
  return (heightPt && heightPt > 0 ? heightPt : STATUS_BAR_FALLBACK_HEIGHT_PT) * STATUS_BAR_TOP_SHARE;
}

/** Whether a text reads as the status-bar clock: a valid time first, no price, few letters. */
function isClockReading(label: string): boolean {
  const text = label.normalize('NFKC').trim();
  const time = STATUS_CLOCK.exec(text);
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) return false;
  if (PRICE_LIKE.test(text)) return false;
  return (text.match(/\p{L}/gu) ?? []).length <= STATUS_CLOCK_MAX_LETTERS;
}

/**
 * The y of the status-bar row in one observation, anchored on the clock: the
 * topmost clock reading in the top-left of the window (top 12%, left 40%).
 * Null when no clock is visible (a banner covers it, a full-screen app hides
 * it, OCR misread it): then nothing counts as status bar, which fails safe.
 */
export function statusBarRowY(
  elements: readonly ScreenElement[],
  heightPt?: number | null,
  widthPt?: number | null,
): number | null {
  const bottom = statusAreaBottom(heightPt);
  const right = (widthPt && widthPt > 0 ? widthPt : STATUS_BAR_FALLBACK_WIDTH_PT) * STATUS_CLOCK_LEFT_SHARE;
  let row: number | null = null;
  for (const e of elements) {
    if (!e.label || e.y < 0 || e.y >= bottom || e.x < 0 || e.x > right) continue;
    if (!isClockReading(e.label)) continue;
    if (row === null || e.y < row) row = e.y;
  }
  return row;
}

/** Whether an element sits on the status-bar row found by statusBarRowY (never when there is none). */
export function inStatusBarRow(element: ScreenElement, rowY: number | null): boolean {
  return rowY !== null && Math.abs(element.y - rowY) <= STATUS_BAR_HALF_ROW_PT;
}

/**
 * Stable fingerprint of what is on screen, used for change and loop detection.
 * `heightPt` / `widthPt` are the window size (for finding the status bar);
 * without them a portrait Mirroring window is assumed.
 */
export function screenFingerprint(elements: readonly ScreenElement[], heightPt?: number | null, widthPt?: number | null): string {
  const statusRow = statusBarRowY(elements, heightPt, widthPt);
  const normalized = elements
    .filter((e) => e.label)
    // Ignore the status bar (clock, signal, battery) so the fingerprint does not change every minute.
    .filter((e) => !inStatusBarRow(e, statusRow))
    .map((e) => `${e.label.trim().toLowerCase()}@${Math.round(e.x / 20)},${Math.round(e.y / 20)}`)
    .sort()
    .join('|');
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

/** Parses `check_health` output into structured checks. */
export function parseHealth(text: string): { ok: boolean; items: HealthCheckItem[] } {
  const items: HealthCheckItem[] = [];
  for (const line of text.split('\n')) {
    const m = /^\[(ok|WARN|FAIL)\]\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const status = m[1] === 'ok' ? 'ok' : m[1] === 'WARN' ? 'warn' : 'fail';
    const detail = m[2]!;
    items.push({ name: healthName(detail), status, detail });
  }
  return { ok: /^All checks passed/i.test(text.trim()), items };
}

function healthName(detail: string): string {
  if (/process/i.test(detail)) return 'iPhone Mirroring process';
  if (/connected|paused|no window|not running/i.test(detail)) return 'Mirroring session';
  if (/screen capture/i.test(detail)) return 'Screen capture';
  if (/text recognition/i.test(detail)) return 'Text recognition (OCR)';
  return 'Check';
}

export interface DoctorCheck {
  name: string;
  status: 'passed' | 'failed' | 'warned';
  detail: string;
  fix_hint?: string;
}

/** Parses `mirroir doctor --json` (written to stderr, pretty-printed, may follow log lines). */
export function parseDoctorJson(stderr: string): { checks: DoctorCheck[] } | null {
  const start = stderr.indexOf('{\n  "checks"');
  const candidate = start >= 0 ? stderr.slice(start) : stderr.slice(stderr.indexOf('{'));
  try {
    const parsed = JSON.parse(candidate) as { checks?: DoctorCheck[] };
    if (!Array.isArray(parsed.checks)) return null;
    return { checks: parsed.checks };
  } catch {
    return null;
  }
}

/** Recognises Mirroir's permission-denial texts. */
export function isPermissionDenial(text: string): boolean {
  return (
    /^Tool '.+' requires explicit permission/.test(text) ||
    /^Tool '.+' is blocked by deny list/.test(text) ||
    /^Tool '.+' is not in the allow list/.test(text) ||
    /^App '.+' is blocked by permissions config/.test(text)
  );
}

/** Recognises Mirroir's "target paused / not running / window missing" input errors. */
export function classifyInputError(text: string): 'paused' | 'not_running' | 'no_window' | 'bounds' | 'held_touch' | null {
  if (/is paused\. Unlock iPhone/i.test(text)) return 'paused';
  if (/is not running/i.test(text)) return 'not_running';
  if (/window not found/i.test(text)) return 'no_window';
  if (/are outside the '.+' window/i.test(text)) return 'bounds';
  if (/A touch is held/i.test(text)) return 'held_touch';
  return null;
}
