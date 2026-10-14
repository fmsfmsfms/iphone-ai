// Remote access management (passcode, listener status, sessions).

import type { FastifyInstance } from 'fastify';
import { remotePasscodeSchema } from '@iphone-ai/shared';

import type { RemoteAccessApi } from '../../remote/remote-access.js';
import { HttpError, notFound } from '../errors.js';
import { actorFor, noContent, parseBody, requireLocal, requireSession, type RouteDeps } from '../guards.js';

export function registerRemoteRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { auth } = deps;

  const service = (): RemoteAccessApi => {
    const remote = deps.remote();
    if (!remote) throw new HttpError(503, 'remote_unavailable', 'Remote access is not running in this backend.');
    return remote;
  };

  app.get('/api/remote', async (request) => {
    requireSession(request);
    return service().info();
  });

  app.put('/api/remote/passcode', async (request) => {
    const session = requireLocal(request);
    const { passcode } = parseBody(remotePasscodeSchema, request.body);
    await service().setPasscode(passcode, actorFor(session));
    return { passcodeSet: true };
  });

  app.get('/api/remote/sessions', async (request) => {
    const session = requireLocal(request);
    return service().listSessions(session.id);
  });

  app.delete<{ Params: { id: string } }>('/api/remote/sessions/:id', async (request, reply) => {
    const session = requireLocal(request);
    const target = auth.get(request.params.id);
    if (!target || target.revokedAt !== null || target.expiresAt <= Date.now()) throw notFound('Session');
    if (target.kind === 'desktop') {
      throw new HttpError(403, 'cannot_revoke_desktop', 'The desktop app session cannot be revoked; quit the app instead.');
    }
    service().revokeSession(target.id, actorFor(session));
    return noContent(reply);
  });

  app.post('/api/remote/sessions/revoke-all', async (request) => {
    const session = requireLocal(request);
    return { revoked: service().revokeAll(session.id, actorFor(session)) };
  });
}
