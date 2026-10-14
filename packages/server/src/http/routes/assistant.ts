// AI assistant: conversations, messages (each message starts a task) and tasks.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { startTaskSchema } from '@iphone-ai/shared';

import { notFound } from '../errors.js';
import { actorFor, noContent, parseBody, requireControl, requireSession, type RouteDeps } from '../guards.js';

const createConversationSchema = z.object({ title: z.string().trim().max(200).optional() });

export function registerAssistantRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx, auth } = deps;
  const agents = ctx.agents;

  const conversationExists = (id: string): boolean => agents.listConversations().some((c) => c.id === id);

  app.get('/api/conversations', async () => agents.listConversations());

  app.post('/api/conversations', async (request) => {
    requireControl(request, auth);
    const body = parseBody(createConversationSchema, request.body);
    return agents.createConversation(body.title || undefined);
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    requireControl(request, auth);
    if (!conversationExists(request.params.id)) throw notFound('Conversation');
    agents.deleteConversation(request.params.id);
    return noContent(reply);
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/clear', async (request, reply) => {
    requireControl(request, auth);
    if (!conversationExists(request.params.id)) throw notFound('Conversation');
    agents.clearConversation(request.params.id);
    return noContent(reply);
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (request) => {
    if (!conversationExists(request.params.id)) throw notFound('Conversation');
    return agents.getMessages(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/tasks', async (request) => {
    if (!conversationExists(request.params.id)) throw notFound('Conversation');
    return agents.getTasks(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/messages', async (request) => {
    const session = requireControl(request, auth);
    const body = parseBody(startTaskSchema, request.body);
    if (!conversationExists(request.params.id)) throw notFound('Conversation');
    return agents.startTask(request.params.id, body, actorFor(session));
  });

  app.get('/api/tasks/active', async () => agents.activeTask());

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) => {
    const found = agents.getTask(request.params.id);
    if (!found) throw notFound('Task');
    return found;
  });

  // Pausing and cancelling only reduce what the AI does, so every session may use them.
  app.post<{ Params: { id: string } }>('/api/tasks/:id/pause', async (request) => {
    requireSession(request);
    if (!agents.getTask(request.params.id)) throw notFound('Task');
    return agents.pauseTask(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/resume', async (request) => {
    requireControl(request, auth);
    if (!agents.getTask(request.params.id)) throw notFound('Task');
    return agents.resumeTask(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request) => {
    const session = requireSession(request);
    if (!agents.getTask(request.params.id)) throw notFound('Task');
    return agents.cancelTask(request.params.id, session.kind === 'remote' ? 'Cancelled from a remote device' : 'Cancelled by the user');
  });
}
