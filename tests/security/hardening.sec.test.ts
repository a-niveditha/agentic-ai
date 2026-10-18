/** Malicious input, resource exhaustion, header/CORS hardening and information leaks. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { buildDocx, buildPdf } from '../helpers/fixtures.js';
import { ApiClient, readSse } from '../helpers/http.js';
import { createLogger } from '../../backend/src/lib/logger.js';
import { loadConfig } from '../../backend/src/config/env.js';
import { startTestApp, TEST_JWT_SECRET, type TestHarness } from '../helpers/testApp.js';

let h: TestHarness;
let c: ApiClient;
const logLines: string[] = [];
const sink = { write: (l: string) => void logLines.push(l) };

beforeAll(async () => {
  h = await startTestApp({ overrides: { logger: createLogger('debug', sink) }, script: [{ text: 'ok' }], repeatLast: true, env: { MAX_UPLOAD_MB: '1' } });
  c = new ApiClient(h.server.url);
  await c.signup('hard@sec.test', 'super-secret-password-9');
}, 60_000);
afterAll(() => h.close());

describe('malicious uploads', () => {
  it('a docx zip bomb is refused before it is inflated', async () => {
    const z = new JSZip();
    z.file('word/document.xml', Buffer.alloc(40 * 1024 * 1024, 0x41));
    const bomb = Buffer.from(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const t = performance.now();
    const r = await c.upload('bomb.docx', bomb, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(r.status).toBe(413);
    expect(performance.now() - t).toBeLessThan(3000);
    expect((await c.json('GET', '/api/v1/documents')).body.documents).toEqual([]);
  });

  it('an oversized upload is cut off with 413 and nothing is stored', async () => {
    expect((await c.upload('huge.txt', Buffer.alloc(2 * 1024 * 1024, 65), 'text/plain')).status).toBe(413);
  });

  it('executable / script / archive payloads are rejected by type and by content', async () => {
    const payloads: [string, Buffer][] = [
      ['evil.exe', Buffer.from('MZ\u0090\u0000\u0003')], ['evil.sh', Buffer.from('#!/bin/sh\nrm -rf /')], ['evil.php', Buffer.from('<?php system($_GET[0]); ?>')],
      ['evil.svg', Buffer.from('<svg onload=alert(1)/>')], ['archive.zip', Buffer.from('PK\u0003\u0004abc')], ['evil.js', Buffer.from('process.exit(1)')], ['noext', Buffer.from('plain')],
    ];
    for (const [name, buf] of payloads) {
      const r = await c.upload(name, buf, 'application/octet-stream');
      expect({ name, status: r.status }).toEqual({ name, status: 415 });
    }
  });

  it('magic-byte mismatches (PDF as .txt, ELF as .md, zip as .json) are rejected', async () => {
    expect((await c.upload('a.txt', buildPdf('x'), 'text/plain')).status).toBe(422);
    expect((await c.upload('a.md', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 'text/markdown')).status).toBe(422);
    expect((await c.upload('a.json', await buildDocx('x'), 'application/json')).status).toBe(422);
  });

  it('stored content with HTML/script is returned as inert JSON with nosniff', async () => {
    const r = await c.json('POST', '/api/v1/documents', { json: { title: '<script>alert(1)</script>.txt', text: '<img src=x onerror=alert(1)> payload' } });
    expect(r.status).toBe(202);
    const res = await c.request('GET', '/api/v1/documents');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('resource exhaustion', () => {
  it('deeply nested JSON bodies do not crash the server', async () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    const res = await fetch(h.server.url + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: deep });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await fetch(h.server.url + '/api/v1/health')).status).toBe(200);
  });

  it('huge headers / many query params are refused or ignored without a 5xx', async () => {
    const res = await fetch(h.server.url + '/api/v1/health?' + Array.from({ length: 5000 }, (_, i) => `p${i}=x`).join('&'));
    expect(res.status).toBeLessThan(500);
    const big = await fetch(h.server.url + '/api/v1/health', { headers: { 'X-Junk': 'a'.repeat(60_000) } }).then((r) => r.status, () => 431);
    expect([200, 400, 431]).toContain(big);
    expect((await fetch(h.server.url + '/api/v1/health')).status).toBe(200);
  });

  it('oversized chat messages and absurd session counts are bounded', async () => {
    const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id;
    expect((await c.request('POST', `/api/v1/chat/sessions/${s}/messages`, { json: { text: 'x'.repeat(100_000) } })).status).toBe(400);
    expect((await c.request('POST', `/api/v1/chat/sessions/${s}/messages`, { json: { text: 'x', extra: 'y'.repeat(10) } })).status).toBe(200);
  });

  it('unicode edge cases (NUL, lone surrogates, RTL overrides, huge emoji) are stored and returned intact or rejected, never crash', async () => {
    const weird = ['a\u0000b', '\ud800', '‮evil', '👨‍👩‍👧‍👦'.repeat(200), '𠜎'.repeat(500)];
    const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id;
    for (const text of weird) {
      const res = await c.request('POST', `/api/v1/chat/sessions/${s}/messages`, { json: { text } });
      expect(res.status).toBeLessThan(500);
      await res.text();
    }
    expect((await fetch(h.server.url + '/api/v1/health')).status).toBe(200);
  });

  it('path traversal in URLs and ids does not escape the API', async () => {
    for (const p of ['/api/../etc/passwd', '/api/%2e%2e/%2e%2e/etc/passwd', '/api/v1/documents/..%2f..%2fetc%2fpasswd', '/api/v1/chat/sessions/%00', '/api//documents']) {
      const r = await fetch(h.server.url + p, { headers: { Authorization: `Bearer ${c.token}` } });
      expect([400, 404]).toContain(r.status);
    }
  });
});

describe('transport hardening', () => {
  it('sends strict security headers on API responses', async () => {
    const res = await fetch(h.server.url + '/api/v1/health');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('referrer-policy')).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('cross-origin-opener-policy')).toBeTruthy();
  });

  it('CORS never reflects arbitrary origins, never allows credentials, and preflights are tight', async () => {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:3000.evil.example', 'http://localhost:3001']) {
      const r = await fetch(h.server.url + '/api/v1/auth/me', { headers: { Origin: origin } });
      expect({ origin, acao: r.headers.get('access-control-allow-origin') }).toEqual({ origin, acao: null });
    }
    const ok = await fetch(h.server.url + '/api/v1/auth/me', { headers: { Origin: 'http://localhost:3000' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('SSE responses cannot be cached or buffered by intermediaries', async () => {
    const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id;
    const res = await c.request('POST', `/api/v1/chat/sessions/${s}/messages`, { json: { text: 'hi' } });
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await readSse(res);
  });
});

describe('information leaks', () => {
  it('error responses never include stack traces, file paths, SQL or library names', async () => {
    const probes = await Promise.all([
      c.json('GET', '/api/nope'), c.json('POST', '/api/v1/auth/login', { json: {}, auth: false }), c.json('GET', '/api/v1/documents/not-a-uuid'),
      fetch(h.server.url + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }).then(async (r) => ({ status: r.status, body: await r.json() })),
    ]);
    for (const p of probes) expect(JSON.stringify(p.body)).not.toMatch(/node_modules|\.ts:\d+|at \w+ \(|prisma|SELECT |SQLITE|\/home\//i);
  });

  it('logs never contain bearer tokens, tickets, passwords or password hashes', async () => {
    const r = await c.json('POST', '/api/v1/auth/stream-ticket', { json: {} });
    const ticket = r.body.ticket as string;
    await fetch(`${h.server.url}/api/v1/chat/sessions/3f2b8c1e-0000-4000-8000-000000000001/stream?ticket=${ticket}&text=hi`);
    await new ApiClient(h.server.url).json('POST', '/api/v1/auth/login', { json: { email: 'hard@sec.test', password: 'super-secret-password-9' }, auth: false });
    await new ApiClient(h.server.url).json('POST', '/api/v1/auth/login', { json: { email: 'hard@sec.test', password: 'a-wrong-password-leak-probe' }, auth: false });
    const joined = logLines.join('\n');
    expect(joined.length).toBeGreaterThan(100); // logging is actually on
    expect(joined).not.toContain(c.token!);
    expect(joined).not.toContain(ticket);
    expect(joined).not.toContain('super-secret-password-9');
    expect(joined).not.toContain('a-wrong-password-leak-probe');
    expect(joined).not.toMatch(/\$2[aby]\$\d\d\$/);
    expect(joined).not.toContain(TEST_JWT_SECRET);
  });

  it('API responses never expose password hashes, internal tenant ids in citations, or stored raw content', async () => {
    const doc = (await c.json('POST', '/api/v1/documents', { json: { title: 'leakcheck', text: 'Leak check document about zebras and quartz.' } })).body;
    expect(JSON.stringify(doc)).not.toMatch(/passwordHash|contentHash|"content"/);
    await c.waitForIndexing();
    const rag = await c.json('POST', '/api/v1/rag/query', { json: { question: 'zebras quartz' } });
    expect(JSON.stringify(rag.body)).not.toMatch(/contentHash|passwordHash/);
    const userId = (await c.json('GET', '/api/v1/auth/me')).body.user.id;
    for (const cit of rag.body.citations ?? []) expect(JSON.stringify(cit)).not.toContain(userId);
  });

  it('API docs expose no secrets, and are off by default in production configs', async () => {
    const spec = JSON.stringify(await (await fetch(h.server.url + '/api/v1/docs-json')).json());
    expect(spec).not.toContain(TEST_JWT_SECRET);
    expect(loadConfig({ JWT_SECRET: 'x'.repeat(32), NODE_ENV: 'production' }).docsEnabled).toBe(false);
  });

  it('readiness output is coarse (statuses only) and unauthenticated-safe', async () => {
    const body = JSON.stringify(await (await fetch(h.server.url + '/api/v1/ready')).json());
    expect(body).not.toMatch(/localhost|127\.0\.0\.1|ECONN|key|secret|password|http:/i);
  });

  it('startup refuses weak or missing secrets and wildcard CORS in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'super-secret-agentic-ai-jwt-token-key-2026' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), CORS_ORIGINS: '*' })).toThrow();
  });
});
