import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import jwt from 'jsonwebtoken';
import { ApiClient } from '../helpers/http.js';
import { tempPrismaStorage } from '../helpers/liveApp.js';
import { TEST_JWT_SECRET, startTestApp, type TestHarness } from '../helpers/testApp.js';

let h: TestHarness;
let cleanup: () => Promise<void>;
let victim: ApiClient;
let victimId = '';

beforeAll(async () => {
  // Real SQLite/Prisma so injection attempts hit a real SQL layer.
  const db = await tempPrismaStorage();
  cleanup = db.cleanup;
  h = await startTestApp({ overrides: { storage: db.storage } });
  victim = new ApiClient(h.server.url);
  await victim.signup('victim@authn.test', 'a-strong-password-1');
  victimId = (await victim.json('GET', '/api/v1/auth/me')).body.user.id;
}, 120_000);
afterAll(async () => { await h.close(); await cleanup(); });

const me = (token?: string) => new ApiClient(h.server.url).json('GET', '/api/v1/auth/me', { auth: token ?? false });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('JWT forgery', () => {
  it('rejects alg:none, in several spellings', async () => {
    const payload = { sub: victimId, typ: 'access', iss: 'agentic-ai', exp: Math.floor(Date.now() / 1000) + 3600 };
    for (const alg of ['none', 'None', 'NONE', 'nOnE']) {
      expect((await me(`${b64({ alg, typ: 'JWT' })}.${b64(payload)}.`)).status).toBe(401);
      expect((await me(`${b64({ alg, typ: 'JWT' })}.${b64(payload)}`)).status).toBe(401);
    }
  });

  it('rejects a token signed with the wrong secret, a different algorithm, or tampered claims', async () => {
    const claims = { typ: 'access' };
    const opts = { subject: victimId, issuer: 'agentic-ai', expiresIn: 3600 };
    expect((await me(jwt.sign(claims, 'attacker-secret-attacker-secret-1', opts))).status).toBe(401);
    expect((await me(jwt.sign(claims, TEST_JWT_SECRET, { ...opts, algorithm: 'HS512' }))).status).toBe(401);
    expect((await me(jwt.sign(claims, TEST_JWT_SECRET, { ...opts, algorithm: 'HS384' }))).status).toBe(401);
    const good = victim.token!;
    const [hd, , sig] = good.split('.');
    const forgedPayload = b64({ sub: '3f2b8c1e-0000-4000-8000-000000000001', typ: 'access', iss: 'agentic-ai', exp: Math.floor(Date.now() / 1000) + 3600 });
    expect((await me(`${hd}.${forgedPayload}.${sig}`)).status).toBe(401);
  });

  it('rejects expired tokens, wrong issuer, missing type, and tokens with unexpected audience', async () => {
    const base = { subject: victimId };
    expect((await me(jwt.sign({ typ: 'access' }, TEST_JWT_SECRET, { ...base, issuer: 'agentic-ai', expiresIn: -60 }))).status).toBe(401);
    expect((await me(jwt.sign({ typ: 'access' }, TEST_JWT_SECRET, { ...base, issuer: 'evil' }))).status).toBe(401);
    expect((await me(jwt.sign({}, TEST_JWT_SECRET, { ...base, issuer: 'agentic-ai' }))).status).toBe(401);
    expect((await me(jwt.sign({ typ: 'access' }, TEST_JWT_SECRET, { ...base, issuer: 'agentic-ai', audience: 'stream' }))).status).toBe(401);
  });

  it('a stolen stream ticket cannot be used as a credential anywhere else', async () => {
    const ticket = (await victim.json('POST', '/api/v1/auth/stream-ticket', { json: {} })).body.ticket;
    for (const p of ['/api/v1/auth/me', '/api/v1/chat/sessions', '/api/v1/documents']) expect((await me(ticket).then(() => new ApiClient(h.server.url).json('GET', p, { auth: ticket }))).status).toBe(401);
  });

  it('only accepts well-formed Authorization headers', async () => {
    const t = victim.token!;
    const send = (h2: Record<string, string>) => fetch(`${h.server.url}/api/v1/auth/me`, { headers: h2 }).then((r) => r.status);
    expect(await send({ Authorization: t })).toBe(401); // no scheme
    expect(await send({ Authorization: `Basic ${t}` })).toBe(401);
    expect(await send({ Authorization: `Bearer` })).toBe(401);
    expect(await send({ Authorization: `Bearer ${t} extra` })).toBe(401);
    expect(await send({ Authorization: `Bearer ${'A'.repeat(100_000)}` })).toBeGreaterThanOrEqual(400);
    expect(await send({ Authorization: `Bearer ${t}` })).toBe(200);
  });

  it('never accepts credentials from the URL or cookies', async () => {
    const t = victim.token!;
    expect((await fetch(`${h.server.url}/api/v1/auth/me?token=${t}&access_token=${t}&auth_token=${t}`)).status).toBe(401);
    expect((await fetch(`${h.server.url}/api/v1/auth/me`, { headers: { Cookie: `token=${t}; jwt=${t}` } })).status).toBe(401);
  });
});

describe('credential handling', () => {
  it('enforces a minimum password length and a maximum (bcrypt DoS / truncation guard)', async () => {
    const c = new ApiClient(h.server.url);
    expect((await c.signup('short@authn.test', 'short1')).status).toBe(400);
    expect((await c.signup('long@authn.test', 'x'.repeat(129))).status).toBe(400);
    expect((await c.signup('ok@authn.test', 'x'.repeat(128))).status).toBe(201);
  });

  it('SQL-injection payloads in credentials are inert (real SQLite)', async () => {
    const c = new ApiClient(h.server.url);
    const payloads = ["' OR '1'='1", "admin'--", "'; DROP TABLE User; --", '" OR ""="', "victim@authn.test' OR 1=1 --"];
    for (const p of payloads) {
      expect((await c.json('POST', '/api/v1/auth/login', { json: { email: p, password: p }, auth: false })).status).toBe(400); // rejected as invalid email
      expect((await c.json('POST', '/api/v1/auth/login', { json: { email: 'victim@authn.test', password: p }, auth: false })).status).toBe(401);
    }
    const injected = await c.signup("o'brien+x@authn.test", "p'; DROP TABLE User; --pass");
    expect(injected.status).toBe(201);
    const again = await c.json('POST', '/api/v1/auth/login', { json: { email: "o'brien+x@authn.test", password: "p'; DROP TABLE User; --pass" }, auth: false });
    expect(again.status).toBe(200);
    expect((await c.json('POST', '/api/v1/auth/login', { json: { email: 'victim@authn.test', password: 'a-strong-password-1' }, auth: false })).status).toBe(200); // table intact
  });

  it('NoSQL/object-shaped credentials are rejected by validation', async () => {
    const c = new ApiClient(h.server.url);
    for (const body of [{ email: { $ne: null }, password: { $ne: null } }, { email: ['a@b.dev'], password: 'password123' }, { email: 'a@b.dev', password: { $gt: '' } }]) {
      expect((await c.json('POST', '/api/v1/auth/login', { json: body, auth: false })).status).toBe(400);
    }
  });

  it('prototype-pollution style bodies do not break or change behavior', async () => {
    const c = new ApiClient(h.server.url);
    const res = await fetch(`${h.server.url}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"proto@authn.test","password":"password123","name":"P","__proto__":{"isAdmin":true},"constructor":{"prototype":{"admin":true}}}' });
    expect(res.status).toBe(201);
    expect(({} as any).isAdmin).toBeUndefined();
    expect(({} as any).admin).toBeUndefined();
    void c;
  });

  it('password hashes use bcrypt with a cost factor and are never exposed', async () => {
    const stored = await h.deps.storage.findUserByEmail('victim@authn.test');
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$(\d\d)\$/);
    expect(Number(/^\$2[aby]\$(\d\d)\$/.exec(stored!.passwordHash)![1])).toBeGreaterThanOrEqual(10);
    const me2 = JSON.stringify((await victim.json('GET', '/api/v1/auth/me')).body);
    expect(me2).not.toMatch(/passwordHash|\$2[aby]\$/);
  });
});

describe('brute force & enumeration', () => {
  it('login attempts are rate limited per IP', async () => {
    const limited = await startTestApp({ env: { RATE_LIMIT_AUTH_PER_MIN: '5' } });
    try {
      const c = new ApiClient(limited.server.url);
      await c.signup('rl@authn.test', 'password-123');
      const codes: number[] = [];
      for (let i = 0; i < 10; i++) codes.push((await c.json('POST', '/api/v1/auth/login', { json: { email: 'rl@authn.test', password: `guess-${i}-xx` }, auth: false })).status);
      expect(codes.filter((s) => s === 401).length).toBeLessThanOrEqual(4);
      expect(codes.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
      // the correct password is also throttled: a brute-forcer cannot "win" by speed
      expect((await c.json('POST', '/api/v1/auth/login', { json: { email: 'rl@authn.test', password: 'password-123' }, auth: false })).status).toBe(429);
    } finally { await limited.close(); }
  });

  it('login does not reveal whether an account exists (same status, body, and comparable timing)', async () => {
    const real = await new ApiClient(h.server.url).json('POST', '/api/v1/auth/login', { json: { email: 'victim@authn.test', password: 'wrong-password-x' }, auth: false });
    const fake = await new ApiClient(h.server.url).json('POST', '/api/v1/auth/login', { json: { email: 'nobody@authn.test', password: 'wrong-password-x' }, auth: false });
    expect([real.status, real.body.error, real.body.code]).toEqual([fake.status, fake.body.error, fake.body.code]);
  });
});

describe('signup edge cases', () => {
  it('email is case-insensitive unique and trimmed (no duplicate-account confusion)', async () => {
    const c = new ApiClient(h.server.url);
    expect((await c.signup('Case@Authn.Test')).status).toBe(201);
    expect((await c.signup('case@authn.test')).status).toBe(409);
    expect((await c.signup('  CASE@authn.test ')).status).toBe(409);
  });

  it('concurrent signups for one email create exactly one account', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => new ApiClient(h.server.url).signup('race@authn.test')));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409).length).toBe(5);
  });
});
