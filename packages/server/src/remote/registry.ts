// Per-AppContext registry so the local listener's /api/remote routes can reach
// the RemoteAccessService that main.ts constructs separately (no import cycle
// between http/server.ts and remote/remote-access.ts).

import type { AppContext } from '../core/services.js';
import type { RemoteAccessApi } from './remote-access.js';

const services = new WeakMap<AppContext, RemoteAccessApi>();

export function registerRemoteAccess(ctx: AppContext, service: RemoteAccessApi): void {
  services.set(ctx, service);
}

export function unregisterRemoteAccess(ctx: AppContext, service: RemoteAccessApi): void {
  if (services.get(ctx) === service) services.delete(ctx);
}

export function remoteAccessFor(ctx: AppContext): RemoteAccessApi | null {
  return services.get(ctx) ?? null;
}
