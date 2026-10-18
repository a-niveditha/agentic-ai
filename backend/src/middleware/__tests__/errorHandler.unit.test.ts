import { describe, expect, it } from 'bun:test';
import express from 'express';
import { z } from 'zod';
import { InvalidAgentContextError } from '../../../../agent/src/index.js';
import { listen } from '../../../../tests/helpers/http.js';
import { AppError } from '../../lib/errors.js';
import { createLogger } from '../../lib/logger.js';
import { errorHandler, notFoundHandler } from '../errorHandler.js';
import { validate } from '../validate.js';

async function run(thrower: () => unknown) {
  const app = express();
  app.use(express.json());
  app.get('/boom', (_req, _res, next) => next(thrower()));
  app.get('/stream-boom', (_req, res, next) => { res.write('partial'); next(new Error('mid-stream')); });
  app.post('/v', validate(z.object({ n: z.coerce.number().int().min(1) })), (req, res) => res.json(req.body));
  app.get('/q', validate(z.object({ page: z.coerce.number().default(1) }), 'query'), (req, res) => res.json(req.query));
  app.use(notFoundHandler);
  app.use(errorHandler(createLogger('silent')));
  const server = await listen(app);
  return { server, get: async (path = '/boom') => { const r = await fetch(server.url + path); const text = await r.text(); let body: any; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, headers: r.headers }; } };
}

describe('errorHandler mapping', () => {
  const cases: [string, () => unknown, number, string][] = [
    ['AppError', () => new AppError(418, 'teapot', 'I am a teapot', { extra: 1 }), 418, 'teapot'],
    ['ZodError', () => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e; } }, 400, 'validation_error'],
    ['InvalidAgentContextError', () => new InvalidAgentContextError('bad ctx'), 403, 'forbidden'],
    ['body too large', () => Object.assign(new Error('too big'), { type: 'entity.too.large' }), 413, 'payload_too_large'],
    ['multer file size', () => Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' }), 413, 'payload_too_large'],
    ['JSON parse failure', () => Object.assign(new Error('bad json'), { type: 'entity.parse.failed' }), 400, 'invalid_json'],
    ['MulterError', () => Object.assign(new Error('Unexpected field'), { name: 'MulterError' }), 400, 'upload_error'],
    ['multipart parser', () => new Error('Malformed part header'), 400, 'upload_error'],
    ['prisma init', () => Object.assign(new Error('x'), { name: 'PrismaClientInitializationError' }), 503, 'service_unavailable'],
    ['prisma timeout code', () => Object.assign(new Error('x'), { code: 'P2024' }), 503, 'service_unavailable'],
    ['sqlite busy', () => new Error('SQLITE_BUSY: database is locked'), 503, 'service_unavailable'],
    ['anything else', () => new Error('internal path /srv/x.ts'), 500, 'internal_error'],
    ['non-error throwable', () => 'a string', 500, 'internal_error'],
  ];
  for (const [label, thrower, status, code] of cases) {
    it(`${label} -> ${status} ${code}`, async () => {
      const t = await run(thrower);
      try {
        const r = await t.get();
        expect(r.status).toBe(status);
        expect(r.body.code).toBe(code);
        expect(JSON.stringify(r.body)).not.toMatch(/\/srv\/x\.ts|stack/);
      } finally { await t.server.close(); }
    });
  }

  it('503s carry Retry-After and AppError extras/headers are preserved', async () => {
    const t = await run(() => new Error('SQLITE_BUSY'));
    try { expect((await t.get()).headers.get('retry-after')).toBe('5'); } finally { await t.server.close(); }
    const t2 = await run(() => new AppError(429, 'slow', 'Slow down', { limit: 5 }, { 'Retry-After': '7' }));
    try {
      const r = await t2.get();
      expect(r.body.limit).toBe(5);
      expect(r.headers.get('retry-after')).toBe('7');
    } finally { await t2.server.close(); }
  });

  it('errors after streaming has begun just end the response (no second set of headers)', async () => {
    const t = await run(() => null);
    try {
      const r = await t.get('/stream-boom');
      expect(r.status).toBe(200);
      expect(r.body).toBe('partial');
    } finally { await t.server.close(); }
  });

  it('notFoundHandler produces JSON 404s', async () => {
    const t = await run(() => null);
    try {
      const r = await t.get('/nope');
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('not_found');
    } finally { await t.server.close(); }
  });
});

describe('validate middleware', () => {
  it('replaces body/query with parsed, coerced and stripped values and reports issues', async () => {
    const t = await run(() => null);
    try {
      const ok = await fetch(t.server.url + '/v', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: '5', extra: 'dropped' }) });
      expect(await ok.json()).toEqual({ n: 5 });
      const bad = await fetch(t.server.url + '/v', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: 0 }) });
      expect(bad.status).toBe(400);
      const body = await bad.json();
      expect(body.code).toBe('validation_error');
      expect(body.issues[0].path).toBe('n');
      expect((await t.get('/q')).body).toEqual({ page: 1 });
      expect((await t.get('/q?page=3')).body).toEqual({ page: 3 });
    } finally { await t.server.close(); }
  });
});
