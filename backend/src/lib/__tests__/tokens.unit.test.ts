import { describe, expect, it } from 'bun:test';
import jwt from 'jsonwebtoken';
import { AppError } from '../errors.js';
import { InMemoryTicketStore, TokenService } from '../tokens.js';

const SECRET = 'unit-test-secret-0123456789-abcdefghij';
const svc = (o: Partial<ConstructorParameters<typeof TokenService>[0]> = {}) => new TokenService({ secret: SECRET, accessTtl: '1h', ticketTtlSeconds: 60, ...o });
const user = { id: '3f2b8c1e-0000-4000-8000-000000000001', email: 'a@b.test' };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'no-error'; };

describe('access tokens', () => {
  it('round-trips user id and email', () => {
    const s = svc();
    expect(s.verifyAccess(s.signAccess(user))).toEqual({ userId: user.id, email: user.email });
  });

  it('rejects garbage, wrong secret, expired and alg:none tokens', () => {
    const s = svc();
    expect(code(() => s.verifyAccess('garbage'))).toBe('invalid_token');
    expect(code(() => s.verifyAccess(svc({ secret: 'another-secret-that-is-long-enough!!' }).signAccess(user)))).toBe('invalid_token');
    const expired = jwt.sign({ typ: 'access' }, SECRET, { subject: user.id, issuer: 'agentic-ai', expiresIn: -10 });
    expect(code(() => s.verifyAccess(expired))).toBe('invalid_token');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, typ: 'access', iss: 'agentic-ai' })).toString('base64url')}.`;
    expect(code(() => s.verifyAccess(none))).toBe('invalid_token');
  });

  it('rejects tokens from another issuer or algorithm family', () => {
    const s = svc();
    expect(code(() => s.verifyAccess(jwt.sign({ typ: 'access' }, SECRET, { subject: 'x', issuer: 'someone-else' })))).toBe('invalid_token');
    expect(code(() => s.verifyAccess(jwt.sign({ typ: 'access' }, SECRET, { subject: 'x', issuer: 'agentic-ai', algorithm: 'HS512' })))).toBe('invalid_token');
  });

  it('rejects tokens without the access type (e.g. legacy or hand-made)', () => {
    const s = svc();
    expect(code(() => s.verifyAccess(jwt.sign({ id: user.id }, SECRET, { issuer: 'agentic-ai' })))).toBe('invalid_token');
    expect(code(() => s.verifyAccess(jwt.sign({ typ: 'refresh' }, SECRET, { subject: 'x', issuer: 'agentic-ai' })))).toBe('invalid_token');
  });

  it('a stream ticket is NOT usable as an access token', () => {
    const s = svc();
    const { ticket } = s.signTicket(user.id);
    expect(code(() => s.verifyAccess(ticket))).toBe('invalid_token');
  });
});

describe('stream tickets', () => {
  it('are single-use', () => {
    const s = svc();
    const { ticket, expiresInSeconds } = s.signTicket(user.id);
    expect(expiresInSeconds).toBe(60);
    expect(s.consumeTicket(ticket)).toEqual({ userId: user.id, sessionId: undefined });
    expect(code(() => s.consumeTicket(ticket))).toBe('invalid_ticket');
  });

  it('an access token is NOT usable as a ticket', () => {
    const s = svc();
    expect(code(() => s.consumeTicket(s.signAccess(user)))).toBe('invalid_token');
  });

  it('expire quickly', async () => {
    const s = svc({ ticketTtlSeconds: 1 });
    const { ticket } = s.signTicket(user.id);
    await new Promise((r) => setTimeout(r, 1200));
    expect(code(() => s.consumeTicket(ticket))).toBe('invalid_token');
  });

  it('can be bound to a session: wrong session is refused (and does not burn the ticket for the right one)', () => {
    const s = svc();
    const { ticket } = s.signTicket(user.id, 'session-a');
    expect(code(() => s.consumeTicket(ticket, 'session-b'))).toBe('invalid_ticket');
    expect(s.consumeTicket(ticket, 'session-a').sessionId).toBe('session-a');
  });

  it('rejects forged tickets (wrong audience / signature / missing jti)', () => {
    const s = svc();
    const noAud = jwt.sign({ typ: 'stream' }, SECRET, { subject: user.id, issuer: 'agentic-ai', jwtid: 'j1', expiresIn: 60 });
    expect(code(() => s.consumeTicket(noAud))).toBe('invalid_token');
    const noJti = jwt.sign({ typ: 'stream' }, SECRET, { subject: user.id, issuer: 'agentic-ai', audience: 'stream', expiresIn: 60 });
    expect(code(() => s.consumeTicket(noJti))).toBe('invalid_ticket');
    const badSig = jwt.sign({ typ: 'stream' }, 'wrong-secret-wrong-secret-wrong!', { subject: user.id, issuer: 'agentic-ai', audience: 'stream', jwtid: 'j2', expiresIn: 60 });
    expect(code(() => s.consumeTicket(badSig))).toBe('invalid_token');
  });

  it('every ticket is unique', () => {
    const s = svc();
    expect(s.signTicket(user.id).ticket).not.toBe(s.signTicket(user.id).ticket);
  });
});

describe('InMemoryTicketStore', () => {
  it('consumes once and forgets expired ids', () => {
    const store = new InMemoryTicketStore();
    expect(store.consume('a', Date.now() + 10_000)).toBe(true);
    expect(store.consume('a', Date.now() + 10_000)).toBe(false);
    expect(store.consume('old', Date.now() - 1)).toBe(true);
    expect(store.consume('b', Date.now() + 10_000)).toBe(true); // triggers cleanup of 'old'
    expect(store.consume('old', Date.now() + 10_000)).toBe(true);
  });
});
