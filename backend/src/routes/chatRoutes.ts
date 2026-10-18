import { Router } from 'express';
import { z } from 'zod';
import { createEvent } from '@agentic-ai/agent';
import { AppError, notFound } from '../lib/errors.js';
import { openSse } from '../lib/sse.js';
import { requireAuth, requireTicket, currentUserId, type AuthenticatedRequest } from '../middleware/auth.js';
import { createLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import type { Dependencies } from '../container.js';
import type { IChatMessage } from '../services/types.js';

const IdParams = z.object({ id: z.string().uuid() });
const CreateSessionBody = z.object({ title: z.string().trim().min(1).max(100).optional() });
const RenameBody = z.object({ title: z.string().trim().min(1).max(100) });

export function parseMetadata(m: IChatMessage) {
  if (!m.metadata) return undefined;
  try {
    return JSON.parse(m.metadata);
  } catch {
    return undefined;
  }
}

export function createChatRouter(deps: Dependencies): Router {
  const router = Router();
  const { storage, tokens, chat, config } = deps;
  const MessageBody = z.object({ text: z.string().trim().min(1).max(config.MAX_MESSAGE_CHARS) });
  const TicketQuery = z.object({ ticket: z.string().min(1), text: z.string().trim().min(1).max(Math.min(config.MAX_MESSAGE_CHARS, 2000)) });
  const chatLimiter = createLimiter({ perMinute: config.RATE_LIMIT_CHAT_PER_MIN, keyByUser: true, message: 'You are sending messages too quickly.' });

  async function streamTurn(req: AuthenticatedRequest, res: any, text: string) {
    const userId = currentUserId(req);
    const sessionId = req.params.id!;
    await chat.assertCanChat(userId, sessionId);
    const sse = openSse(req, res, { heartbeatMs: config.SSE_HEARTBEAT_MS });
    try {
      await chat.runChatTurn({ userId, sessionId, text, signal: sse.signal, onEvent: (e) => sse.send(e) });
    } catch (err) {
      const e = err instanceof AppError ? err : null;
      deps.logger.error({ err, sessionId }, 'chat turn failed');
      sse.send(createEvent('error', { message: e?.message ?? 'Something went wrong while generating the reply.', code: e?.code ?? 'internal_error' }));
    } finally {
      sse.close();
    }
  }

  // Header-authenticated routes
  const authed = Router();
  authed.use(requireAuth(tokens));

  authed.get('/sessions', async (req: AuthenticatedRequest, res, next) => {
    try {
      res.json({ sessions: await storage.listSessions(currentUserId(req)) });
    } catch (err) {
      next(err);
    }
  });

  authed.post('/sessions', validate(CreateSessionBody), async (req: AuthenticatedRequest, res, next) => {
    try {
      res.status(201).json({ session: await storage.createSession(currentUserId(req), req.body.title) });
    } catch (err) {
      next(err);
    }
  });

  authed.patch('/sessions/:id', validate(IdParams, 'params'), validate(RenameBody), async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!(await storage.renameSession(currentUserId(req), req.params.id!, req.body.title))) throw notFound('Session');
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  authed.delete('/sessions/:id', validate(IdParams, 'params'), async (req: AuthenticatedRequest, res, next) => {
    try {
      if (!(await storage.deleteSession(currentUserId(req), req.params.id!))) throw notFound('Session');
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  authed.get('/sessions/:id/messages', validate(IdParams, 'params'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const messages = await storage.getMessages(currentUserId(req), req.params.id!);
      if (!messages) throw notFound('Session');
      res.json({ messages: messages.map((m) => ({ ...m, metadata: parseMetadata(m) ?? null })) });
    } catch (err) {
      next(err);
    }
  });

  /** Send a message and stream the reply as Server-Sent Events. */
  authed.post('/sessions/:id/messages', chatLimiter, validate(IdParams, 'params'), validate(MessageBody), async (req: AuthenticatedRequest, res, next) => {
    try {
      await streamTurn(req, res, req.body.text);
    } catch (err) {
      next(err);
    }
  });

  /** EventSource-friendly variant: single-use ticket in the query string instead of a header. */
  router.get('/sessions/:id/stream', validate(IdParams, 'params'), validate(TicketQuery, 'query'), requireTicket(tokens), chatLimiter, async (req: AuthenticatedRequest, res, next) => {
    try {
      await streamTurn(req, res, (req.query as any).text);
    } catch (err) {
      next(err);
    }
  });

  router.use(authed);

  return router;
}
