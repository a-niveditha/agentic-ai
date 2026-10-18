import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { InvalidAgentContextError } from '@agentic-ai/agent';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

/** Prisma / driver failures that mean "the database is not reachable", not "your request is wrong". */
function isDatabaseDown(err: any): boolean {
  const name = String(err?.name ?? '');
  const code = String(err?.code ?? '');
  return (
    name === 'PrismaClientInitializationError' ||
    name === 'PrismaClientRustPanicError' ||
    ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(code) ||
    /SQLITE_BUSY|SQLITE_CANTOPEN|database is locked|Can't reach database/i.test(String(err?.message ?? ''))
  );
}

export const notFoundHandler: RequestHandler = (req, _res, next) => next(new AppError(404, 'not_found', `Route ${req.method} ${req.path} not found`));

/** Last-resort error mapper. Never leaks stack traces or internal messages to clients. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: any, req, res, _next) => {
    if (res.headersSent) {
      // Streaming already started: all we can do is end the response.
      res.end();
      return;
    }
    const requestId = (req as any).id ?? res.getHeader('x-request-id');

    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';
    let extra: Record<string, unknown> | undefined;
    let headers: Record<string, string> | undefined;

    if (err instanceof AppError) {
      ({ status, code, message, extra, headers } = err);
    } else if (err instanceof ZodError) {
      status = 400;
      code = 'validation_error';
      message = 'Invalid request';
      extra = { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    } else if (err instanceof InvalidAgentContextError) {
      status = 403;
      code = 'forbidden';
      message = 'Invalid execution context';
    } else if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
      status = 413;
      code = 'payload_too_large';
      message = 'Payload too large';
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      code = 'invalid_json';
      message = 'Malformed JSON body';
    } else if (err?.name === 'MulterError' || /Malformed part header|Unexpected end of (form|multipart data)|Boundary not found|Malformed (urlencoded )?form|Multipart: /i.test(String(err?.message ?? ''))) {
      status = 400;
      code = 'upload_error';
      message = 'Invalid upload';
    } else if (isDatabaseDown(err)) {
      status = 503;
      code = 'service_unavailable';
      message = 'The database is temporarily unavailable. Please retry shortly.';
      headers = { 'Retry-After': '5' };
    }

    if (status >= 500) logger.error({ err, requestId, path: req.path }, 'request failed');
    else logger.debug({ code, requestId, path: req.path }, 'request rejected');

    for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
    res.status(status).json({ error: message, code, requestId, ...(extra ?? {}) });
  };
}
