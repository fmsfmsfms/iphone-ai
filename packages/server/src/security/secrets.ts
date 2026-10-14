// Secret storage backed by the macOS login Keychain via /usr/bin/security.
//
// Secrets are written through `security -i` on stdin, hex-encoded with -X,
// so they never appear in a process argument list (visible to `ps`).

import { spawn } from 'node:child_process';

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
  has(account: string): Promise<boolean>;
}

const SERVICE = 'iPhone AI';
const SECURITY_BIN = '/usr/bin/security';

function run(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

function assertAccount(account: string): void {
  if (!/^[A-Za-z0-9:._-]{1,100}$/.test(account)) {
    throw new Error(`Invalid keychain account name: ${account}`);
  }
}

export class KeychainSecretStore implements SecretStore {
  constructor(private readonly service: string = SERVICE) {}

  async get(account: string): Promise<string | null> {
    assertAccount(account);
    const res = await run(['find-generic-password', '-s', this.service, '-a', account, '-w']);
    if (res.code !== 0) return null;
    const value = res.stdout.replace(/\n$/, '');
    return value.length > 0 ? value : null;
  }

  async set(account: string, secret: string): Promise<void> {
    assertAccount(account);
    const hex = Buffer.from(secret, 'utf8').toString('hex');
    const command = `add-generic-password -U -s "${this.service}" -a "${account}" -l "${this.service} (${account})" -X ${hex}\n`;
    const res = await run(['-i'], command);
    if (res.code !== 0 || /error/i.test(res.stderr)) {
      throw new Error(`Keychain write failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }

  async delete(account: string): Promise<void> {
    assertAccount(account);
    await run(['delete-generic-password', '-s', this.service, '-a', account]);
  }

  async has(account: string): Promise<boolean> {
    assertAccount(account);
    const res = await run(['find-generic-password', '-s', this.service, '-a', account]);
    return res.code === 0;
  }
}

/** Non-persistent store for tests and CI. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }

  async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }
}

export function providerSecretAccount(providerId: string): string {
  return `provider:${providerId}`;
}
