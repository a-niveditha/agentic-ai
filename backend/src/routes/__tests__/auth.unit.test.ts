import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import jwt from 'jsonwebtoken';
import { ApiClient } from '../../../../tests/helpers/http.js';
import { TEST_JWT_SECRET, startTestApp, type TestHarness } from '../../../../tests/helpers/testApp.js';

let h: TestHarness;
beforeAll(async () => { h = await startTestApp(); });
afterAll(() => h.close());
const api = () => new ApiClient(h.server.url);

describe('POST /api/v1/auth/signup', () => {
  it('creates an account, returns the user (no hash) and a token', async () => {
    const r = await api().json('POST', '/api/v1/auth/signup', { json: { email: 'New@Example.com ', password: 'password123', name: ' Nia ' }, auth: false });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: 'new@example.com', name: 'Nia' });
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(typeof r.body.token).toBe('string');
  });

  it('stores a bcrypt hash, never the password', async () => {
    await api().signup('hash@test.dev', 'my-secret-pass');
    const stored = await h.storage.findUserByEmail('hash@test.dev');
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored!.passwordHash).not.toContain('my-secret-pass');
  });

  it('rejects duplicates (409), including different casing', async () => {
    await api().signup('dup@test.dev');
    expect((await api().signup('dup@test.dev')).status).toBe(409);
    expect((await api().signup('DUP@test.dev')).status).toBe(409);
  });

  it('validates input', async () => {
    const bad: any[] = [{}, { email: 'x', password: 'password123', name: 'N' }, { email: 'a@b.dev', password: 'short', name: 'N' }, { email: 'a@b.dev', password: 'password123', name: '' }, { email: 'a@b.dev', password: 'x'.repeat(200), name: 'N' }, { email: 'a@b.dev', password: 12345678, name: 'N' }];
    for (const body of bad) {
      const r = await api().json('POST', '/api/v1/auth/signup', { json: body, auth: false });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('validation_error');
    }
  });

  it('survives a malformed JSON body with a clean 400', async () => {
    const res = await fetch(`${h.server.url}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_json');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('logs in with correct credentials', async () => {
    await api().signup('login@test.dev', 'password123');
    const r = await api().json('POST', '/api/v1/auth/login', { json: { email: 'LOGIN@test.dev', password: 'password123' }, auth: false });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('login@test.dev');
    expect(r.body.token).toBeTruthy();
  });

  it('gives the SAME response for unknown email and wrong password (no user enumeration)', async () => {
    await api().signup('known@test.dev', 'password123');
    const wrongPw = await api().json('POST', '/api/v1/auth/login', { json: { email: 'known@test.dev', password: 'wrong-password' }, auth: false });
    const noUser = await api().json('POST', '/api/v1/auth/login', { json: { email: 'ghost@test.dev', password: 'password123' }, auth: false });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error).toBe(noUser.body.error);
    expect(wrongPw.body.code).toBe(noUser.body.code);
  });

  it('does comparable work for unknown users (constant-ish timing)', async () => {
    await api().signup('timing@test.dev', 'password123');
    const time = async (email: string) => { const t = performance.now(); await api().json('POST', '/api/v1/auth/login', { json: { email, password: 'nope-nope-nope' }, auth: false }); return performance.now() - t; };
    await time('timing@test.dev'); // warm
    const known = Math.min(await time('timing@test.dev'), await time('timing@test.dev'));
    const unknown = Math.min(await time('nobody@test.dev'), await time('nobody2@test.dev'));
    expect(unknown).toBeGreaterThan(known * 0.4); // an early-return would be ~100x faster than a bcrypt compare
  });

  it('validates input', async () => {
    expect((await api().json('POST', '/api/v1/auth/login', { json: { email: 'a@b.dev' }, auth: false })).status).toBe(400);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the profile for a valid token', async () => {
    const c = api(); await c.signup('me@test.dev');
    const r = await c.json('GET', '/api/v1/auth/me');
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('me@test.dev');
  });

  it('rejects missing, malformed, tampered, expired and wrong-type tokens', async () => {
    const c = api(); await c.signup('me2@test.dev');
    const good = c.token!;
    const user = (await c.json('GET', '/api/v1/auth/me')).body.user;
    const expired = jwt.sign({ typ: 'access' }, TEST_JWT_SECRET, { subject: user.id, issuer: 'agentic-ai', expiresIn: -5 });
    const forged = jwt.sign({ typ: 'access' }, 'attacker-secret-attacker-secret!!', { subject: user.id, issuer: 'agentic-ai' });
    const ticket = h.deps.tokens.signTicket(user.id).ticket;
    const cases: [string, string | false][] = [['none', false], ['garbage', 'garbage'], ['tampered', good.slice(0, -3) + 'abc'], ['expired', expired], ['forged', forged], ['ticket as bearer', ticket]];
    for (const [label, tok] of cases) {
      const r = await api().json('GET', '/api/v1/auth/me', { auth: tok === false ? false : tok });
      expect({ label, status: r.status }).toEqual({ label, status: 401 });
    }
  });

  it('does NOT accept tokens in the query string', async () => {
    const c = api(); await c.signup('q@test.dev');
    for (const key of ['token', 'auth_token', 'access_token']) {
      const res = await fetch(`${h.server.url}/api/v1/auth/me?${key}=${c.token}`);
      expect(res.status).toBe(401);
    }
  });

  it('401 for a valid token whose user no longer exists is a 404 user', async () => {
    const token = h.deps.tokens.signAccess({ id: '3f2b8c1e-0000-4000-8000-0000000000aa', email: 'gone@test.dev' });
    expect((await api().json('GET', '/api/v1/auth/me', { auth: token })).status).toBe(404);
  });
});

describe('POST /api/v1/auth/stream-ticket', () => {
  it('requires auth', async () => {
    expect((await api().json('POST', '/api/v1/auth/stream-ticket', { json: {}, auth: false })).status).toBe(401);
  });
  it('issues a short-lived ticket', async () => {
    const c = api(); await c.signup('t1@test.dev');
    const r = await c.json('POST', '/api/v1/auth/stream-ticket', { json: {} });
    expect(r.status).toBe(200);
    expect(r.body.expiresInSeconds).toBe(60);
    expect(h.deps.tokens.consumeTicket(r.body.ticket).userId).toBeTruthy();
  });
  it('refuses to bind a ticket to someone else\'s session', async () => {
    const a = api(); await a.signup('ta@test.dev');
    const b = api(); await b.signup('tb@test.dev');
    const sess = (await a.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session;
    expect((await b.json('POST', '/api/v1/auth/stream-ticket', { json: { sessionId: sess.id } })).status).toBe(404);
    expect((await a.json('POST', '/api/v1/auth/stream-ticket', { json: { sessionId: sess.id } })).status).toBe(200);
  });
  it('validates sessionId format', async () => {
    const c = api(); await c.signup('t2@test.dev');
    expect((await c.json('POST', '/api/v1/auth/stream-ticket', { json: { sessionId: 'not-a-uuid' } })).status).toBe(400);
  });
});
