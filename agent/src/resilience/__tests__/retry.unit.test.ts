import { describe, expect, it } from 'bun:test';
import { CircuitBreaker } from '../circuitBreaker.js';
import { CircuitOpenError } from '../errors.js';
import { resilientCall, sleep, withRetry } from '../retry.js';

const transient = Object.assign(new Error('unavailable'), { status: 503 });
const permanent = Object.assign(new Error('bad request'), { status: 400 });
const noSleep = async () => {};

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    let n = 0;
    expect(await withRetry(async () => ++n)).toBe(1);
  });

  it('retries transient errors up to the limit then throws the last error', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw transient; }, { retries: 2, sleep: noSleep })).rejects.toBe(transient);
    expect(n).toBe(3);
  });

  it('succeeds when a later attempt works', async () => {
    let n = 0;
    const out = await withRetry(async (attempt) => { n++; if (attempt < 2) throw transient; return 'ok'; }, { retries: 3, sleep: noSleep });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw permanent; }, { retries: 5, sleep: noSleep })).rejects.toBe(permanent);
    expect(n).toBe(1);
  });

  it('uses exponential backoff capped at maxDelayMs', async () => {
    const delays: number[] = [];
    await withRetry(async () => { throw transient; }, {
      retries: 4, baseDelayMs: 100, maxDelayMs: 500, jitter: 0, sleep: async (ms) => { delays.push(ms); },
    }).catch(() => {});
    expect(delays).toEqual([100, 200, 400, 500]);
  });

  it('applies bounded jitter', async () => {
    const delays: number[] = [];
    await withRetry(async () => { throw transient; }, {
      retries: 1, baseDelayMs: 1000, jitter: 0.5, random: () => 1, sleep: async (ms) => { delays.push(ms); },
    }).catch(() => {});
    expect(delays[0]).toBe(1500);
  });

  it('honors a Retry-After hint larger than the backoff', async () => {
    const delays: number[] = [];
    const limited = Object.assign(new Error('slow'), { status: 429, retryAfter: 2 });
    await withRetry(async () => { throw limited; }, { retries: 1, baseDelayMs: 10, maxDelayMs: 10_000, jitter: 0, sleep: async (ms) => { delays.push(ms); } }).catch(() => {});
    expect(delays[0]).toBe(2000);
  });

  it('calls onRetry with attempt number', async () => {
    const seen: number[] = [];
    await withRetry(async () => { throw transient; }, { retries: 2, sleep: noSleep, onRetry: (_e, a) => seen.push(a) }).catch(() => {});
    expect(seen).toEqual([1, 2]);
  });

  it('aborts promptly when the signal fires during backoff', async () => {
    const c = new AbortController();
    const p = withRetry(async () => { throw transient; }, { retries: 3, baseDelayMs: 5_000, signal: c.signal });
    setTimeout(() => c.abort(), 20);
    const err = await p.catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('refuses to start when already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(withRetry(async () => 1, { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('sleep', () => {
  it('resolves after the delay and rejects on abort', async () => {
    const t = Date.now();
    await sleep(30);
    expect(Date.now() - t).toBeGreaterThanOrEqual(25);
    const c = new AbortController();
    const p = sleep(5_000, c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('resilientCall', () => {
  it('retries through the breaker and succeeds', async () => {
    const breaker = new CircuitBreaker({ name: 't', failureThreshold: 5 });
    let n = 0;
    const out = await resilientCall(breaker, async () => { if (++n < 3) throw transient; return 'done'; }, { retries: 3, sleep: noSleep });
    expect(out).toBe('done');
    expect(breaker.state).toBe('closed');
  });

  it('stops retrying as soon as the circuit opens', async () => {
    const breaker = new CircuitBreaker({ name: 't', failureThreshold: 2, cooldownMs: 60_000 });
    let n = 0;
    const err = await resilientCall(breaker, async () => { n++; throw transient; }, { retries: 10, sleep: noSleep }).catch((e) => e);
    expect(n).toBe(2);
    expect(err).toBeInstanceOf(CircuitOpenError);
  });

  it('fails fast without calling when the circuit is already open', async () => {
    const breaker = new CircuitBreaker({ name: 't', failureThreshold: 1, cooldownMs: 60_000 });
    await resilientCall(breaker, async () => { throw transient; }, { retries: 0 }).catch(() => {});
    let called = false;
    await expect(resilientCall(breaker, async () => { called = true; }, { retries: 3, sleep: noSleep })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });
});
