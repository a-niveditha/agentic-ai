import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { AppError } from '../lib/errors.js';

type Source = 'body' | 'query' | 'params';

/** Validates and replaces req[source] with the parsed (stripped, coerced) value. */
export function validate(schema: ZodTypeAny, source: Source = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      return next(
        new AppError(400, 'validation_error', 'Invalid request', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    }
    (req as any)[source] = result.data;
    next();
  };
}
