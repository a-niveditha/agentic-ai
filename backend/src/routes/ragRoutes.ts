import { Router } from 'express';
import { z } from 'zod';
import { createEvent } from '@agentic-ai/agent';
import { openSse } from '../lib/sse.js';
import { requireAuth, currentUserId, type AuthenticatedRequest } from '../middleware/auth.js';
import { createLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import type { Dependencies } from '../container.js';

/** Stand-alone RAG: one question in, a grounded answer with citations out (no agent loop, no chat history). */
export function createRagRouter(deps: Dependencies): Router {
  const router = Router();
  const Body = z.object({
    question: z.string().trim().min(1).max(deps.config.MAX_MESSAGE_CHARS),
    topK: z.number().int().min(1).max(10).optional(),
  });
  router.use(requireAuth(deps.tokens));

  router.post('/query', createLimiter({ perMinute: deps.config.RATE_LIMIT_CHAT_PER_MIN, keyByUser: true }), validate(Body), async (req: AuthenticatedRequest, res, next) => {
    const userId = currentUserId(req);
    const { question, topK } = req.body as z.infer<typeof Body>;
    const retrieve = topK ? { topK } : undefined;
    try {
      if (req.headers.accept?.includes('text/event-stream')) {
        const sse = openSse(req, res, { heartbeatMs: deps.config.SSE_HEARTBEAT_MS });
        try {
          await deps.rag.stream(question, userId, (e) => sse.send({ ...e, timestamp: Date.now() }), { signal: sse.signal, retrieve });
        } catch (err) {
          deps.logger.error({ err }, 'rag stream failed');
          sse.send(createEvent('error', { message: 'Something went wrong while answering.', code: 'internal_error' }));
        } finally {
          sse.close();
        }
        return;
      }
      const answer = await deps.rag.answer(question, userId, { retrieve });
      res.status(answer.status === 'unavailable' ? 503 : 200).json(answer);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
