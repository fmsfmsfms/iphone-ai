// Screen frames (polled screenshots), on-demand capture and OCR description.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HttpError } from '../errors.js';
import { parseBody, requireControl, requireSession, type RouteDeps } from '../guards.js';

const captureSchema = z.object({
  settleMs: z.number().int().min(0).max(5000).optional(),
  resume: z.boolean().optional(),
});

export function registerScreenRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;

  app.get('/api/screen/frame/latest', async (_request, reply) => {
    const frame = ctx.device.getLatestFrame();
    if (!frame) throw new HttpError(404, 'no_frame', 'No screen frame has been captured yet.');
    return reply
      .header('content-type', frame.meta.mimeType)
      .header('cache-control', 'no-store')
      .header('x-frame-seq', String(frame.meta.seq))
      .send(frame.data);
  });

  app.post('/api/screen/capture', async (request) => {
    requireSession(request);
    const body = parseBody(captureSchema, request.body);
    // Resuming a paused session makes Mirroir press the Resume button: that is device input.
    if (body.resume === true) requireControl(request, auth);
    const frame = await ctx.device.captureFrame({
      settleMs: body.settleMs,
      allowResume: body.resume === true,
      priority: 'observe',
      reason: 'user-capture',
    });
    return frame.meta;
  });

  app.post('/api/screen/describe', async (request) => {
    requireSession(request);
    const description = await ctx.device.describe({ includeImage: false });
    return {
      elements: description.elements,
      rawText: description.rawText,
      fingerprint: description.fingerprint,
      geometry: description.geometry,
    };
  });

  app.get('/api/screen/stream', async () => ctx.stream.stats());

  app.get<{ Params: { id: string } }>('/api/screenshots/:id', async (request, reply) => {
    const shot = ctx.screenshots.get(request.params.id);
    if (!shot) throw new HttpError(404, 'not_found', 'Screenshot not found (screenshots are kept in memory unless storing them is enabled).');
    return reply.header('content-type', shot.mimeType).header('cache-control', 'private, no-store').send(shot.data);
  });
}
