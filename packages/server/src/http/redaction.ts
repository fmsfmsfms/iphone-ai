// What leaves the server for whom: diagnostics exports and remote sessions get
// settings without anything that may carry credentials or reveal the macOS
// account name. Local sessions keep the full values (the Settings editor
// round-trips them).

import { homedir } from 'node:os';

import type { AppSettings } from '@iphone-ai/shared';

import { redactSecrets, redactUrl } from '../core/redact.js';
import type { AuthSession } from './auth.js';

/** Replaces the home directory with "~" so exports do not reveal the account name. */
export function scrubText(text: string): string {
  const home = homedir();
  const scrubbed = home ? text.split(home).join('~') : text;
  return redactSecrets(scrubbed);
}

/** Settings without anything secret-like (settings never hold keys; URLs may carry credentials). */
export function exportableSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    connection: { ...settings.connection, mirroirBinaryPath: scrubText(settings.connection.mirroirBinaryPath) },
    ai: {
      ...settings.ai,
      providers: settings.ai.providers.map((p) => ({ ...p, baseUrl: p.baseUrl ? redactUrl(p.baseUrl) : null })),
    },
  };
}

/** Local sessions see settings as stored; remote sessions (and anything unauthenticated) only redacted ones. */
export function settingsForSession(settings: AppSettings, session: Pick<AuthSession, 'kind'> | null): AppSettings {
  return session && session.kind !== 'remote' ? settings : exportableSettings(settings);
}
