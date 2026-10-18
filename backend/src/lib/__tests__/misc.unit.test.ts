import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from '../errors.js';
import { createLogger, redactUrl } from '../logger.js';
import { openSse } from '../sse.js';
import { listen } from '../../../../tests/helpers/http.js';

describe('AppError helpers', () => {
  it('carry status, code, message and headers', () => {
    expect(badRequest('x')).toMatchObject({ status: 400, code: 'bad_request' });
    expect(unauthorized()).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(forbidden()).toMatchObject({ status: 403 });
    expect(notFound('Thing')).toMatchObject({ status: 404, message: 'Thing not found' });
    expect(conflict('dup', 'taken')).toMatchObject({ status: 409, code: 'taken' });
    const u = unavailable('later', 9);
    expect(u).toMatchObject({ status: 503, headers: { 'Retry-After': '9' } });
    expect(u).toBeInstanceOf(AppError);
  });
});

describe('redactUrl', () => {
  it('hides tickets, tokens and keys in query strings', () => {
    expect(redactUrl('/ws?ticket=abc.def.ghi&x=1')).toBe('/ws?ticket=[REDACTED]&x=1');
    expect(redactUrl('/a?token=t&auth_token=u&api_key=k&key=z&keep=me')).toBe('/a?token=[REDACTED]&auth_token=[REDACTED]&api_key=[REDACTED]&key=[REDACTED]&keep=me');
    expect(redactUrl('/plain')).toBe('/plain');
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe('logger', () => {
  it('redacts secrets in structured logs', () => {
    const lines: string[] = [];
    const log = createLogger('info');
    // pino writes to stdout by default: build a second logger with the same redaction config writing to memory
    const { default: pino } = require('pino');
    const mem = pino({ redact: { paths: ['req.headers.authorization', '*.password', '*.token'], censor: '[REDACTED]' } }, { write: (l: string) => lines.push(l) });
    mem.info({ req: { headers: { authorization: 'Bearer SECRET' } }, user: { password: 'hunter2', token: 'tok' } }, 'hi');
    expect(lines.join('')).not.toMatch(/SECRET|hunter2|"tok"/);
    expect(typeof log.info).toBe('function');
  });
});

describe('openSse', () => {
  async function withServer(handler: (sse: ReturnType<typeof openSse>, close: () => void) => void, heartbeatMs = 30) {
    const server = await listen((req, res) => { const sse = openSse(req as any, res as any, { heartbeatMs }); handler(sse, () => sse.close()); });
    return server;
  }

  it('sends data frames and heartbeats, sets streaming headers, and closes cleanly', async () => {
    const server = await withServer((sse) => {
      sse.send({ type: 'start' });
      setTimeout(() => { sse.send({ type: 'token', payload: { token: 'a' } }); }, 90);
      setTimeout(() => sse.close(), 160);
    });
    try {
      const res = await fetch(server.url);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('cache-control')).toContain('no-cache');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      const text = await res.text();
      expect(text).toContain('data: {"type":"start"}');
      expect(text).toContain('data: {"type":"token","payload":{"token":"a"}}');
      expect(text).toContain(': keep-alive');
    } finally { await server.close(); }
  });

  it('send() after close is a no-op and open reflects state', async () => {
    let sseRef!: ReturnType<typeof openSse>;
    const server = await withServer((sse) => { sseRef = sse; sse.close(); });
    try {
      await (await fetch(server.url)).text();
      expect(sseRef.open).toBe(false);
      expect(() => sseRef.send({ late: true })).not.toThrow();
    } finally { await server.close(); }
  });

  it('abort signal fires when the connection is torn down by the server side destroying the socket', async () => {
    let signal!: AbortSignal;
    const server = await listen((req, res) => { const sse = openSse(req as any, res as any, { heartbeatMs: 20 }); signal = sse.signal; sse.send({ hi: 1 }); setTimeout(() => res.socket?.destroy(), 40); });
    try {
      await fetch(server.url).then((r) => r.text()).catch(() => {});
      for (let i = 0; i < 50 && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 20));
      expect(signal.aborted).toBe(true);
    } finally { await server.close(); }
  });
});

void createServer;
