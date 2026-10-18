import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ApiClient, ofType, readSse, tokensOf } from '../../../../tests/helpers/http.js';
import { startTestApp, type TestHarness } from '../../../../tests/helpers/testApp.js';
import { PrismaClientInitializationError } from '@prisma/client/runtime/library';

describe('POST /api/v1/rag/query', () => {
  let h: TestHarness; let c: ApiClient; let n = 0;
  beforeAll(async () => { h = await startTestApp({ script: [{ text: 'The Zorblax protocol uses port 4242 [1].' }], repeatLast: true }); });
  afterAll(() => h.close());
  beforeEach(async () => {
    c = new ApiClient(h.server.url); await c.signup(`rag${++n}@test.dev`); h.model.available = true;
    await c.json('POST', '/api/v1/documents', { json: { title: 'Zorblax Spec', text: 'The Zorblax protocol uses port 4242 and was invented by Dr. Quill.' } });
    await c.waitForIndexing(); // indexing runs in the background
  });

  it('answers as JSON with citations', async () => {
    const r = await c.json('POST', '/api/v1/rag/query', { json: { question: 'Which port does Zorblax use?' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'completed', answer: expect.stringContaining('4242') });
    expect(r.body.citations[0]).toMatchObject({ title: 'Zorblax Spec' });
  });

  it('streams SSE when asked', async () => {
    const res = await c.request('POST', '/api/v1/rag/query', { json: { question: 'Which port does Zorblax use?' }, headers: { Accept: 'text/event-stream' } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(res);
    expect(events[0]!.type).toBe('start');
    expect(ofType(events, 'citation')).toHaveLength(1);
    expect(tokensOf(events)).toContain('4242');
    expect(events.at(-1)!.type).toBe('done');
  });

  it('only sees the caller\'s own documents', async () => {
    const other = new ApiClient(h.server.url); await other.signup(`rag-other${++n}@test.dev`);
    const r = await other.json('POST', '/api/v1/rag/query', { json: { question: 'Which port does Zorblax use?' } });
    expect(r.body.status).toBe('no_context');
    expect(r.body.citations).toEqual([]);
  });

  it('DEGRADES to passages when the model is down (still 200, status degraded)', async () => {
    h.model.available = false;
    const r = await c.json('POST', '/api/v1/rag/query', { json: { question: 'Which port does Zorblax use?' } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('degraded');
    expect(r.body.answer).toContain('4242');
    expect(r.body.citations).toHaveLength(1);
  });

  it('503 when the knowledge base itself is down', async () => {
    h.embeddings.failNext = 1;
    const r = await c.json('POST', '/api/v1/rag/query', { json: { question: 'anything' } });
    expect(r.status).toBe(503);
    expect(r.body.status).toBe('unavailable');
  });

  it('validates input and requires auth', async () => {
    expect((await c.json('POST', '/api/v1/rag/query', { json: { question: '' } })).status).toBe(400);
    expect((await c.json('POST', '/api/v1/rag/query', { json: { question: 'q', topK: 99 } })).status).toBe(400);
    expect((await c.json('POST', '/api/v1/rag/query', { json: { question: 'q' }, auth: false })).status).toBe(401);
  });
});

describe('health endpoints', () => {
  let h: TestHarness;
  beforeAll(async () => { h = await startTestApp(); });
  afterAll(() => h.close());
  const get = async (p: string) => { const r = await fetch(h.server.url + p); return { status: r.status, body: await r.json() }; };

  it('/api/v1/health is a cheap liveness probe', async () => {
    const r = await get('/api/v1/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('/api/v1/ready lists every component and exposes no internal detail', async () => {
    const r = await get('/api/v1/ready');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('up');
    expect(Object.keys(r.body.components).sort()).toEqual(['database', 'embeddings:fake', 'llm:scripted', 'scraper:fake', 'search:fake', 'tools', 'vectorstore:memory']);
    expect(JSON.stringify(r.body)).not.toMatch(/detail|ECONN|stack/);
  });

  it('a non-critical dependency down => degraded/down status but still 200 (server keeps serving)', async () => {
    h.model.available = false; h.search.fail = new Error('x');
    const r = await get('/api/v1/ready');
    expect(r.status).toBe(200);
    expect(r.body.components['llm:scripted']).toBe('down');
    expect(['degraded', 'down']).toContain(r.body.status);
    h.model.available = true; h.search.fail = undefined;
    expect((await get('/api/v1/ready')).body.components['llm:scripted']).toBe('up'); // recovered
  });

  it('database down => 503', async () => {
    h.storage.failWith = new Error('db down');
    const r = await get('/api/v1/ready');
    expect(r.status).toBe(503);
    expect(r.body.components.database).toBe('down');
    h.storage.failWith = undefined;
    expect((await get('/api/v1/ready')).status).toBe(200);
  });

  it('liveness is unaffected by dependency outages', async () => {
    h.storage.failWith = new Error('db down');
    expect((await get('/api/v1/health')).status).toBe(200);
    h.storage.failWith = undefined;
  });
});

describe('error handling & hardening', () => {
  let h: TestHarness; let c: ApiClient;
  beforeAll(async () => { h = await startTestApp(); c = new ApiClient(h.server.url); await c.signup('err@test.dev'); });
  afterAll(() => h.close());

  it('unknown routes return a JSON 404', async () => {
    const r = await c.json('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });

  it('database outage on a normal route => 503 + Retry-After, no internals leaked', async () => {
    h.storage.failWith = Object.assign(new PrismaClientInitializationError("Can't reach database server at `db:5432`", '5.0.0'), {});
    const r = await c.json('GET', '/api/v1/chat/sessions');
    h.storage.failWith = undefined;
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('5');
    expect(JSON.stringify(r.body)).not.toMatch(/db:5432|Prisma/);
  });

  it('unexpected errors are 500 with a request id but no stack trace or message', async () => {
    h.storage.failWith = new Error('TypeError: secret path /srv/app/db.ts:42');
    const r = await c.json('GET', '/api/v1/chat/sessions');
    h.storage.failWith = undefined;
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ error: 'Internal server error', code: 'internal_error' });
    expect(r.body.requestId).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/srv\/app|TypeError|at /);
  });

  it('echoes/generates a request id and rejects malformed incoming ones', async () => {
    const ok = await fetch(h.server.url + '/api/v1/health', { headers: { 'x-request-id': 'my-trace-id-12345' } });
    expect(ok.headers.get('x-request-id')).toBe('my-trace-id-12345');
    const bad = await fetch(h.server.url + '/api/v1/health', { headers: { 'x-request-id': 'evil\r\nheader: x' .replace(/[\r\n]/g, ' ') } });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('oversized JSON bodies are rejected with 413', async () => {
    const res = await fetch(h.server.url + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.dev', password: 'x'.repeat(4 * 1024 * 1024) }) });
    expect(res.status).toBe(413);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await fetch(h.server.url + '/api/v1/health');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBeTruthy();
    expect(res.headers.get('strict-transport-security')).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });

  it('CORS: allowlisted origin is echoed, others get no CORS headers', async () => {
    const good = await fetch(h.server.url + '/api/v1/health', { headers: { Origin: 'http://localhost:3000' } });
    expect(good.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const evil = await fetch(h.server.url + '/api/v1/health', { headers: { Origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(h.server.url + '/api/v1/chat/sessions', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('the API is versioned: unversioned and unknown-version paths do not exist', async () => {
    const anon = new ApiClient(h.server.url);
    for (const path of ['/api/health', '/api/ready', '/api/auth/login', '/api/documents', '/api/chat/sessions', '/api/rag/query', '/api/v2/health', '/health']) {
      expect({ path, status: (await anon.json('GET', path, { auth: false })).status }).toEqual({ path, status: 404 });
    }
    expect((await anon.json('GET', '/api/v1/health', { auth: false })).status).toBe(200);
    expect((await anon.json('GET', '/api/v1/ready', { auth: false })).status).toBe(200);
  });

  it('docs are served when enabled and disabled when not', async () => {
    expect((await fetch(h.server.url + '/api/v1/docs-json')).status).toBe(200);
    const spec = await (await fetch(h.server.url + '/api/v1/docs-json')).json();
    expect(spec.servers[0].url).toBe('/api/v1');
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/auth/login', '/chat/sessions/{id}/messages', '/documents', '/rag/query', '/ready']));
    const off = await startTestApp({ env: { ENABLE_DOCS: 'false' } });
    try { expect((await fetch(off.server.url + '/api/v1/docs-json')).status).toBe(404); } finally { await off.close(); }
  });

  it('rate limits auth endpoints per IP (429) and chat per user', async () => {
    const limited = await startTestApp({ env: { RATE_LIMIT_AUTH_PER_MIN: '3', RATE_LIMIT_CHAT_PER_MIN: '2' } });
    try {
      const a = new ApiClient(limited.server.url);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await a.json('POST', '/api/v1/auth/login', { json: { email: 'x@y.dev', password: 'whatever1' }, auth: false })).status);
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
      const limitedBody = await a.json('POST', '/api/v1/auth/login', { json: { email: 'x@y.dev', password: 'whatever1' }, auth: false });
      expect(limitedBody.body.code).toBe('rate_limited');
    } finally { await limited.close(); }

    const chatLimited = await startTestApp({ env: { RATE_LIMIT_CHAT_PER_MIN: '2' } });
    try {
      const u = new ApiClient(chatLimited.server.url); await u.signup('rl@test.dev');
      const s = (await u.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session;
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) { const r = await u.request('POST', `/api/v1/chat/sessions/${s.id}/messages`, { json: { text: 'hi' } }); codes.push(r.status); await r.text(); }
      expect(codes).toEqual([200, 200, 429]);
    } finally { await chatLimited.close(); }
  });
});
