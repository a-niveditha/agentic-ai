import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { unauthorized } from '../lib/errors.js';
import type { TokenService } from '../lib/tokens.js';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string };
}

/**
 * Bearer-token authentication. The token is accepted ONLY from the Authorization header: credentials in
 * query strings end up in logs, proxies and browser history. (Stream endpoints use short-lived tickets.)
 */
export function requireAuth(tokens: TokenService): RequestHandler {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !/^Bearer\s+\S+$/i.test(header)) return next(unauthorized('Authorization token missing'));
    try {
      const claims = tokens.verifyAccess(header.replace(/^Bearer\s+/i, ''));
      req.user = { id: claims.userId, email: claims.email };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** For EventSource-style GET stream endpoints: authenticates with a single-use `?ticket=` instead. */
export function requireTicket(tokens: TokenService, sessionParam = 'id'): RequestHandler {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (!ticket) return next(unauthorized('Stream ticket missing', 'invalid_ticket'));
    try {
      const claims = tokens.consumeTicket(ticket, req.params[sessionParam]);
      req.user = { id: claims.userId, email: '' };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function currentUserId(req: AuthenticatedRequest): string {
  if (!req.user?.id) throw unauthorized();
  return req.user.id;
}
