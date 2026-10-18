import { errorMessage } from './health.js';

export type ErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'unavailable'
  | 'bad_request'
  | 'aborted'
  | 'circuit_open'
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  retryable: boolean;
  /** Counts toward opening a circuit breaker (i.e. the service itself is unhealthy). */
  serviceFailure: boolean;
  retryAfterMs?: number;
  message: string;
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(public readonly circuit: string, retryAfterMs: number) {
    super(`Service '${circuit}' is temporarily unavailable (circuit open).`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

function statusOf(err: any): number | undefined {
  const candidates = [err?.status, err?.statusCode, err?.response?.status, err?.cause?.status];
  for (const c of candidates) if (typeof c === 'number') return c;
  const m = /\b(?:status(?: code)?:?\s*|\[)(\d{3})\b/i.exec(String(err?.message ?? ''));
  return m ? Number(m[1]) : undefined;
}

function retryAfterOf(err: any): number | undefined {
  const raw =
    err?.retryAfter ??
    err?.response?.headers?.get?.('retry-after') ??
    err?.response?.headers?.['retry-after'] ??
    err?.headers?.['retry-after'];
  if (raw == null) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Maps any thrown value to a retry/breaker policy decision. */
export function classifyError(err: unknown): ClassifiedError {
  const message = errorMessage(err);
  const e = err as any;

  if (err instanceof CircuitOpenError) {
    return { kind: 'circuit_open', retryable: false, serviceFailure: false, retryAfterMs: err.retryAfterMs, message };
  }
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || /\baborted\b/i.test(message)) {
    return { kind: 'aborted', retryable: false, serviceFailure: false, message };
  }

  const status = statusOf(e);
  const retryAfterMs = retryAfterOf(e);

  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|too many requests|quota/i.test(message)) {
    return { kind: 'rate_limit', retryable: true, serviceFailure: true, retryAfterMs, message };
  }
  if (status === 401 || status === 403 || /API key|API_KEY_INVALID|PERMISSION_DENIED|unauthori[sz]ed/i.test(message)) {
    return { kind: 'auth', retryable: false, serviceFailure: true, message };
  }
  if (status && status >= 400 && status < 500) {
    return { kind: 'bad_request', retryable: false, serviceFailure: false, message };
  }
  if (status && status >= 500) {
    return { kind: 'unavailable', retryable: true, serviceFailure: true, retryAfterMs, message };
  }
  if (e?.name === 'TimeoutError' || /timed? ?out|ETIMEDOUT|deadline exceeded/i.test(message)) {
    return { kind: 'timeout', retryable: true, serviceFailure: true, message };
  }
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|network|socket|unable to connect|connection/i.test(message)) {
    return { kind: 'network', retryable: true, serviceFailure: true, message };
  }
  return { kind: 'unknown', retryable: false, serviceFailure: false, message };
}

/** Short, user-safe explanation of a failure. Never includes raw provider payloads or keys. */
export function friendlyMessage(kind: ErrorKind, what = 'The service'): string {
  switch (kind) {
    case 'rate_limit':
      return `${what} is rate-limited right now. Please try again in a moment.`;
    case 'timeout':
      return `${what} took too long to respond. Please try again.`;
    case 'network':
    case 'unavailable':
    case 'circuit_open':
      return `${what} is temporarily unavailable. Please try again shortly.`;
    case 'auth':
      return `${what} rejected our credentials. The operator needs to check the configuration.`;
    case 'aborted':
      return 'The request was cancelled.';
    case 'bad_request':
      return `${what} could not process the request.`;
    default:
      return `${what} hit an unexpected error.`;
  }
}
