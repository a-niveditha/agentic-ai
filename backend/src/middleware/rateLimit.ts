import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { AuthenticatedRequest } from './auth.js';

export function createLimiter(options: { perMinute: number; keyByUser?: boolean; message?: string }): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: options.perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (options.keyByUser && (req as AuthenticatedRequest).user?.id ? `u:${(req as AuthenticatedRequest).user!.id}` : (req.ip ?? 'unknown')),
    handler: (_req, res) => {
      res.status(429).json({ error: options.message ?? 'Too many requests. Please slow down.', code: 'rate_limited' });
    },
  });
}
