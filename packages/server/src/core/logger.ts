// Small structured logger: stderr + rotating file. Every line passes through
// secret redaction so API keys and bearer tokens never reach disk.

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

import { redactSecrets, redactValue } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
  setLevel(level: LogLevel): void;
}

interface LoggerState {
  level: LogLevel;
  file: string | null;
  console: boolean;
}

export function createLogger(options: { file?: string | null; level?: LogLevel; console?: boolean } = {}): Logger {
  const state: LoggerState = {
    level: options.level ?? 'info',
    file: options.file ?? null,
    console: options.console ?? true,
  };
  return makeLogger(state, 'app');
}

function makeLogger(state: LoggerState, scope: string): Logger {
  const write = (level: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      scope,
      msg: redactSecrets(msg),
      ...(data ? { data: redactValue(data) } : {}),
    });
    if (state.console) process.stderr.write(`${line}\n`);
    if (state.file) {
      try {
        rotateIfNeeded(state.file);
        appendFileSync(state.file, `${line}\n`, { mode: 0o600 });
      } catch {
        // Logging must never crash the backend.
      }
    }
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (child) => makeLogger(state, `${scope}.${child}`),
    setLevel: (level) => {
      state.level = level;
    },
  };
}

function rotateIfNeeded(file: string): void {
  if (!existsSync(file)) return;
  if (statSync(file).size < MAX_LOG_BYTES) return;
  renameSync(file, `${file}.1`);
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  setLevel: () => undefined,
};
