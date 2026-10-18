export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request') => new AppError(400, code, message);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') => new AppError(401, code, message);
export const forbidden = (message = 'Forbidden', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const unavailable = (message: string, retryAfterSeconds = 5) =>
  new AppError(503, 'service_unavailable', message, undefined, { 'Retry-After': String(retryAfterSeconds) });
