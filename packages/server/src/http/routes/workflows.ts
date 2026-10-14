// Automations: saved workflows, runs and the manual recorder.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workflowInputSchema, workflowSuggestSchema, type WorkflowInput } from '@iphone-ai/shared';

import { notFound } from '../errors.js';
import { actorFor, noContent, parseBody, requireControl, requireSession, type RouteDeps } from '../guards.js';

const runsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });
const retrySchema = z.object({ fromFailedStep: z.boolean() });
const recorderStartSchema = z.object({ name: z.string().trim().min(1).max(120) });
const recorderStopSchema = z.object({ save: z.boolean() });

export function registerWorkflowRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;
  const workflows = ctx.workflows;

  const requireWorkflow = (id: string) => {
    const workflow = workflows.get(id);
    if (!workflow) throw notFound('Workflow');
    return workflow;
  };
  const requireRun = (id: string) => {
    const run = workflows.getRun(id);
    if (!run) throw notFound('Workflow run');
    return run;
  };

  app.get('/api/workflows', async () => workflows.list());

  app.post('/api/workflows', async (request) => {
    requireControl(request, auth);
    const input = parseBody(workflowInputSchema, request.body) as WorkflowInput;
    return workflows.create(input);
  });

  app.post('/api/workflows/suggest', async (request) => {
    requireControl(request, auth);
    const body = parseBody(workflowSuggestSchema, request.body);
    return workflows.suggest(body.goal, body.providerId);
  });

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (request) => requireWorkflow(request.params.id));

  app.put<{ Params: { id: string } }>('/api/workflows/:id', async (request) => {
    requireControl(request, auth);
    requireWorkflow(request.params.id);
    const input = parseBody(workflowInputSchema, request.body) as WorkflowInput;
    return workflows.update(request.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
    requireControl(request, auth);
    requireWorkflow(request.params.id);
    workflows.remove(request.params.id);
    return noContent(reply);
  });

  app.post<{ Params: { id: string } }>('/api/workflows/:id/run', async (request) => {
    const session = requireControl(request, auth);
    requireWorkflow(request.params.id);
    return workflows.run(request.params.id, actorFor(session));
  });

  app.get<{ Params: { id: string } }>('/api/workflows/:id/runs', async (request) => {
    requireWorkflow(request.params.id);
    return workflows.runs(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/workflows/:id/export-skill', async (request) => {
    requireControl(request, auth);
    requireWorkflow(request.params.id);
    return workflows.exportSkill(request.params.id);
  });

  app.get('/api/workflow-runs', async (request) => {
    const { limit } = runsQuerySchema.parse(request.query ?? {});
    return workflows.runs(undefined, limit);
  });

  app.get<{ Params: { id: string } }>('/api/workflow-runs/:id', async (request) => requireRun(request.params.id));

  // Pausing and stopping only reduce what automation does, so every session may use them.
  app.post<{ Params: { id: string } }>('/api/workflow-runs/:id/pause', async (request) => {
    requireSession(request);
    requireRun(request.params.id);
    return workflows.pause(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/workflow-runs/:id/resume', async (request) => {
    requireControl(request, auth);
    requireRun(request.params.id);
    return workflows.resume(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/workflow-runs/:id/stop', async (request) => {
    const session = requireSession(request);
    requireRun(request.params.id);
    return workflows.stop(request.params.id, session.kind === 'remote' ? 'Stopped from a remote device' : 'Stopped by the user');
  });

  app.post<{ Params: { id: string } }>('/api/workflow-runs/:id/retry', async (request) => {
    const session = requireControl(request, auth);
    requireRun(request.params.id);
    const { fromFailedStep } = parseBody(retrySchema, request.body);
    return workflows.retry(request.params.id, fromFailedStep, actorFor(session));
  });

  app.get('/api/recorder', async () => workflows.recorderStatus());

  app.post('/api/recorder/start', async (request) => {
    requireControl(request, auth);
    const { name } = parseBody(recorderStartSchema, request.body);
    return workflows.startRecording(name);
  });

  app.post('/api/recorder/stop', async (request) => {
    requireControl(request, auth);
    const { save } = parseBody(recorderStopSchema, request.body);
    return workflows.stopRecording(save);
  });
}
