import { randomBytes, randomUUID } from 'node:crypto';

/** Prefixed, sortable-enough identifiers: "task_9f2c…". */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** URL-safe random token for sessions and one-time codes. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
