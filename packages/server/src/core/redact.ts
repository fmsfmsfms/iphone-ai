// Redaction helpers for logs, activity history and diagnostics exports.

const SECRET_KEY_PATTERN =
  /(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|^token$|secret|password|passcode|authorization|cookie|^otp$|^pin$)/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/** Replaces anything that looks like an API key or bearer token inside free text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

export interface RedactOptions {
  /** Keep typed text verbatim (privacy.logTypedText). */
  keepTypedText?: boolean;
}

/** Describes typed text without revealing it: "«12 characters»". */
export function describeTypedText(text: string): string {
  return `«${[...text].length} characters»`;
}

/**
 * Produces a log-safe copy of tool arguments. Typed text is replaced by its
 * length unless the user opted in, secrets are masked, base64 blobs dropped.
 */
export function redactToolArgs(
  tool: string,
  args: Record<string, unknown> | undefined,
  options: RedactOptions = {},
): Record<string, unknown> {
  if (!args) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if ((tool === 'type_text' || key === 'text') && typeof value === 'string') {
      out[key] = options.keepTypedText ? redactSecrets(value) : describeTypedText(value);
      continue;
    }
    if (key === 'url' && typeof value === 'string') {
      out[key] = redactUrl(value);
      continue;
    }
    out[key] = redactValue(value);
  }
  return out;
}

/** Strips query strings and fragments from URLs (they often carry tokens). */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hadQuery = url.search.length > 0 || url.hash.length > 0;
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return hadQuery ? `${url.toString()}?[redacted]` : url.toString();
  } catch {
    return redactSecrets(raw);
  }
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    if (value.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 200))) {
      return `[binary ${value.length} chars]`;
    }
    return redactSecrets(value.length > 4000 ? `${value.slice(0, 4000)}…` : value);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}
