// Remote-access passcode hashing (scrypt). Only the hash is stored, in the
// macOS Keychain, as "scrypt$N$r$p$salt$hash" (salt and hash base64url).

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Keychain account holding the passcode hash. */
export const REMOTE_PASSCODE_ACCOUNT = 'remote:passcode-hash';

const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

function derive(passcode: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode.normalize('NFKC'), salt, keyLength, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function maxmem(n: number, r: number): number {
  return Math.max(64 * 1024 * 1024, 256 * n * r);
}

export async function hashPasscode(passcode: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(passcode, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: maxmem(COST, BLOCK_SIZE),
  });
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time verification. Malformed or out-of-range stored hashes never verify. */
export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  const parts = stored.trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const powerOfTwo = Number.isInteger(n) && n >= 1024 && n <= 1 << 20 && (n & (n - 1)) === 0;
  if (!powerOfTwo || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length < 8 || expected.length < 16 || expected.length > 64) return false;
  const actual = await derive(passcode, salt, expected.length, { N: n, r, p, maxmem: maxmem(n, r) });
  return timingSafeEqual(actual, expected);
}
