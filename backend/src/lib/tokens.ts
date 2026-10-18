import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { unauthorized } from './errors.js';

const ISSUER = 'agentic-ai';
const ALGORITHMS: jwt.Algorithm[] = ['HS256'];

export interface TokenServiceOptions {
  secret: string;
  accessTtl: string;
  ticketTtlSeconds: number;
  now?: () => number;
}

/** Single-use guard for stream tickets. In-memory by default; swap for Redis when running >1 instance. */
export interface TicketStore {
  /** Returns true the first time a jti is consumed, false on any replay. */
  consume(jti: string, expiresAtMs: number): boolean;
}

export class InMemoryTicketStore implements TicketStore {
  private readonly used = new Map<string, number>();
  consume(jti: string, expiresAtMs: number): boolean {
    const now = Date.now();
    for (const [k, exp] of this.used) if (exp < now) this.used.delete(k);
    if (this.used.has(jti)) return false;
    this.used.set(jti, expiresAtMs);
    return true;
  }
}

export interface AccessClaims {
  userId: string;
  email: string;
}
export interface TicketClaims {
  userId: string;
  sessionId?: string;
}

/**
 * Two token types, never interchangeable:
 *  - access tokens (typ 'access'): long-lived, sent as `Authorization: Bearer`
 *  - stream tickets (typ 'stream', aud 'stream'): ~60s, single-use, accepted ONLY via `?ticket=` on stream endpoints,
 *    so a URL that ends up in a log cannot be replayed as a general credential.
 */
export class TokenService {
  constructor(private readonly opts: TokenServiceOptions, private readonly tickets: TicketStore = new InMemoryTicketStore()) {}

  signAccess(user: { id: string; email: string }): string {
    return jwt.sign({ typ: 'access', email: user.email }, this.opts.secret, {
      algorithm: 'HS256',
      subject: user.id,
      issuer: ISSUER,
      expiresIn: this.opts.accessTtl as any,
    });
  }

  signTicket(userId: string, sessionId?: string): { ticket: string; expiresInSeconds: number } {
    const ticket = jwt.sign({ typ: 'stream', ...(sessionId ? { sid: sessionId } : {}) }, this.opts.secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: ISSUER,
      audience: 'stream',
      jwtid: randomUUID(),
      expiresIn: this.opts.ticketTtlSeconds,
    });
    return { ticket, expiresInSeconds: this.opts.ticketTtlSeconds };
  }

  verifyAccess(token: string): AccessClaims {
    const claims = this.verify(token, {});
    if (claims.typ !== 'access' || claims.aud || !claims.sub) throw unauthorized('Token is invalid or expired', 'invalid_token');
    return { userId: claims.sub, email: String(claims.email ?? '') };
  }

  /** Verifies and CONSUMES a ticket (a second use fails). */
  consumeTicket(token: string, expectedSessionId?: string): TicketClaims {
    const claims = this.verify(token, { audience: 'stream' });
    if (claims.typ !== 'stream' || !claims.sub || !claims.jti || !claims.exp) throw unauthorized('Ticket is invalid or expired', 'invalid_ticket');
    if (claims.sid && expectedSessionId && claims.sid !== expectedSessionId) throw unauthorized('Ticket is not valid for this session', 'invalid_ticket');
    if (!this.tickets.consume(claims.jti, claims.exp * 1000)) throw unauthorized('Ticket was already used', 'invalid_ticket');
    return { userId: claims.sub, sessionId: claims.sid };
  }

  private verify(token: string, extra: jwt.VerifyOptions): jwt.JwtPayload & { typ?: string; sid?: string; email?: string } {
    try {
      const payload = jwt.verify(token, this.opts.secret, { algorithms: ALGORITHMS, issuer: ISSUER, ...extra });
      if (typeof payload === 'string') throw new Error('unexpected payload');
      return payload as any;
    } catch {
      throw unauthorized('Token is invalid or expired', 'invalid_token');
    }
  }
}
