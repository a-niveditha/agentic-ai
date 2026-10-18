import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { AppError, notFound } from '../lib/errors.js';
import { requireAuth, currentUserId, type AuthenticatedRequest } from '../middleware/auth.js';
import { createLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import type { Dependencies } from '../container.js';

const credentials = {
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
};
const SignupBody = z.object({ ...credentials, name: z.string().trim().min(1).max(100) });
const LoginBody = z.object({ email: credentials.email, password: z.string().min(1).max(128) });
const TicketBody = z.object({ sessionId: z.string().uuid().optional() });

// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export function createAuthRouter(deps: Dependencies): Router {
  const router = Router();
  const { storage, tokens, config } = deps;
  const authLimiter = createLimiter({ perMinute: config.RATE_LIMIT_AUTH_PER_MIN, message: 'Too many attempts. Please wait a minute.' });

  router.post('/signup', authLimiter, validate(SignupBody), async (req, res, next) => {
    try {
      const { email, password, name } = req.body as z.infer<typeof SignupBody>;
      if (await storage.findUserByEmail(email)) throw new AppError(409, 'email_taken', 'An account with this email already exists');
      const user = await storage.createUser(email, await bcrypt.hash(password, 10), name);
      res.status(201).json({ user, token: tokens.signAccess(user) });
    } catch (err: any) {
      // Lost a race with a concurrent signup for the same email.
      next(err?.code === 'P2002' ? new AppError(409, 'email_taken', 'An account with this email already exists') : err);
    }
  });

  router.post('/login', authLimiter, validate(LoginBody), async (req, res, next) => {
    try {
      const { email, password } = req.body as z.infer<typeof LoginBody>;
      const found = await storage.findUserByEmail(email);
      const ok = await bcrypt.compare(password, found?.passwordHash ?? DUMMY_HASH);
      if (!found || !ok) throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
      res.json({ user: { id: found.id, email: found.email, name: found.name, createdAt: found.createdAt }, token: tokens.signAccess(found) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth(tokens), async (req: AuthenticatedRequest, res, next) => {
    try {
      const user = await storage.findUserById(currentUserId(req));
      if (!user) throw notFound('User');
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  /** Mint a short-lived single-use ticket for EventSource / WebSocket connections that cannot send headers. */
  router.post('/stream-ticket', requireAuth(tokens), validate(TicketBody), async (req: AuthenticatedRequest, res, next) => {
    try {
      const userId = currentUserId(req);
      const { sessionId } = req.body as z.infer<typeof TicketBody>;
      if (sessionId && !(await storage.getSession(userId, sessionId))) throw notFound('Session');
      res.json(tokens.signTicket(userId, sessionId));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
