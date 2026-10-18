import { CircuitBreaker } from './circuitBreaker.js';
import { CircuitOpenError, classifyError } from './errors.js';

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 0..1 fraction of random jitter applied to each delay. */
  jitter?: number;
  signal?: AbortSignal;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8_000;
  const jitter = opts.jitter ?? 0.25;
  const isRetryable = opts.isRetryable ?? ((e) => classifyError(e).retryable);
  const doSleep = opts.sleep ?? sleep;
  const random = opts.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err) || opts.signal?.aborted) throw err;
      const hinted = classifyError(err).retryAfterMs;
      const exp = Math.min(max, base * 2 ** attempt);
      const delay = Math.min(max, Math.max(hinted ?? 0, exp * (1 + jitter * (random() * 2 - 1))));
      opts.onRetry?.(err, attempt + 1, delay);
      await doSleep(delay, opts.signal);
      attempt += 1;
    }
  }
}

/**
 * Standard wrapper for any external call: retries transient errors, and every attempt goes through the
 * breaker so a dead service stops being hammered (an open circuit also stops further retries).
 */
export function resilientCall<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const base = opts.isRetryable ?? ((e: unknown) => classifyError(e).retryable);
  return withRetry(() => breaker.execute(fn), {
    ...opts,
    isRetryable: (e) => !(e instanceof CircuitOpenError) && base(e),
  });
}
