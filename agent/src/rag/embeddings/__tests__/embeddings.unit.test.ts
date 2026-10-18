import { describe, expect, it } from 'bun:test';
import { CircuitBreaker } from '../../../resilience/circuitBreaker.js';
import { FakeEmbeddingProvider } from '../../../testing/FakeEmbeddingProvider.js';
import { createEmbeddingProvider } from '../embeddingFactory.js';
import { GeminiEmbeddingProvider } from '../GeminiEmbeddingProvider.js';
import { LocalEmbeddingProvider } from '../LocalEmbeddingProvider.js';

const fast = { retries: 2, baseDelayMs: 1, jitter: 0, sleep: async () => {} };

function client(failures: Error[] = []) {
  const calls = { docs: 0, query: 0 };
  return {
    calls,
    client: {
      async embedDocuments(d: string[]) { calls.docs++; const f = failures.shift(); if (f) throw f; return d.map(() => [0.1, 0.2, 0.3]); },
      async embedQuery(_q: string) { calls.query++; const f = failures.shift(); if (f) throw f; return [0.3, 0.2, 0.1]; },
    } as any,
  };
}
const e503 = () => Object.assign(new Error('unavailable'), { status: 503 });
const e429 = () => Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });

describe('GeminiEmbeddingProvider', () => {
  it('exposes model metadata used to namespace collections', () => {
    const p = new GeminiEmbeddingProvider({ client: client().client });
    expect(p.metadata).toEqual({ provider: 'google', modelId: 'gemini-embedding-001', dimensions: 3072 });
  });

  it('embeds documents and queries; empty input short-circuits without a call', async () => {
    const c = client();
    const p = new GeminiEmbeddingProvider({ client: c.client, retry: fast });
    expect(await p.embedDocuments(['a', 'b'])).toHaveLength(2);
    expect(await p.embedQuery('q')).toEqual([0.3, 0.2, 0.1]);
    expect(await p.embedDocuments([])).toEqual([]);
    expect(c.calls.docs).toBe(1);
  });

  it('retries transient failures (503, 429) with backoff', async () => {
    const c = client([e503(), e429()]);
    const p = new GeminiEmbeddingProvider({ client: c.client, retry: fast });
    expect(await p.embedDocuments(['x'])).toHaveLength(1);
    expect(c.calls.docs).toBe(3);
  });

  it('gives up after the retry budget and surfaces the error', async () => {
    const c = client([e503(), e503(), e503(), e503()]);
    const p = new GeminiEmbeddingProvider({ client: c.client, retry: fast });
    await expect(p.embedQuery('x')).rejects.toThrow('unavailable');
    expect(c.calls.query).toBe(3);
  });

  it('does not retry client errors', async () => {
    const c = client([Object.assign(new Error('bad input'), { status: 400 })]);
    const p = new GeminiEmbeddingProvider({ client: c.client, retry: fast });
    await expect(p.embedQuery('x')).rejects.toThrow('bad input');
    expect(c.calls.query).toBe(1);
  });

  it('opens the circuit after repeated outages, then fails fast and reports health', async () => {
    const c = client(Array.from({ length: 20 }, e503));
    const breaker = new CircuitBreaker({ name: 'emb', failureThreshold: 3, cooldownMs: 60_000 });
    const p = new GeminiEmbeddingProvider({ client: c.client, retry: fast, breaker });
    await p.embedQuery('x').catch(() => {});
    const calls = c.calls.query;
    const err = await p.embedQuery('y').catch((e) => e);
    expect(err.name).toBe('CircuitOpenError');
    expect(c.calls.query).toBe(calls);
    expect((await p.checkHealth()).status).toBe('down');
  });

  it('without an API key reports down and fails with an auth-style error (no network call)', async () => {
    const saved = { g: process.env.GEMINI_API_KEY, k: process.env.GOOGLE_API_KEY };
    delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
    try {
      const p = new GeminiEmbeddingProvider({});
      expect((await p.checkHealth()).status).toBe('down');
      await expect(p.embedQuery('x')).rejects.toThrow(/API key/);
    } finally {
      if (saved.g) process.env.GEMINI_API_KEY = saved.g;
      if (saved.k) process.env.GOOGLE_API_KEY = saved.k;
    }
  });

  it('healthy provider reports up', async () => {
    expect((await new GeminiEmbeddingProvider({ client: client().client }).checkHealth()).status).toBe('up');
  });
});

describe('LocalEmbeddingProvider', () => {
  it('wraps a client with retries and metadata', async () => {
    const c = client([e503()]);
    const p = new LocalEmbeddingProvider({ client: c.client, retry: fast, model: 'my/model', dimensions: 3 });
    expect(p.metadata).toEqual({ provider: 'local', modelId: 'my/model', dimensions: 3 });
    expect(await p.embedDocuments(['a'])).toEqual([[0.1, 0.2, 0.3]]);
    expect(await p.embedQuery('q')).toHaveLength(3);
    expect(await p.embedDocuments([])).toEqual([]);
    expect((await p.checkHealth()).status).toBe('up');
  });
});

describe('createEmbeddingProvider', () => {
  it('builds the requested provider and rejects unknown ones', () => {
    expect(createEmbeddingProvider({ provider: 'gemini', apiKey: 'k' })).toBeInstanceOf(GeminiEmbeddingProvider);
    expect(() => createEmbeddingProvider({ provider: 'bogus' as any })).toThrow(/Unknown embedding provider/);
  });

  it('defaults to gemini and honors EMBEDDING_PROVIDER', () => {
    const prev = process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_PROVIDER;
    expect(createEmbeddingProvider({ apiKey: 'k' })).toBeInstanceOf(GeminiEmbeddingProvider);
    process.env.EMBEDDING_PROVIDER = 'bogus';
    expect(() => createEmbeddingProvider()).toThrow();
    if (prev) process.env.EMBEDDING_PROVIDER = prev; else delete process.env.EMBEDDING_PROVIDER;
  });
});

describe('FakeEmbeddingProvider', () => {
  it('is deterministic and normalized; similar texts are closer than unrelated ones', async () => {
    const f = new FakeEmbeddingProvider(64);
    const [a, b, c] = await f.embedDocuments(['red apples fall', 'red apples grow', 'quantum chromodynamics']);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(a!, a!)).toBeCloseTo(1);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    expect(await f.embedQuery('red apples fall')).toEqual(a!);
  });
  it('can be told to fail', async () => {
    const f = new FakeEmbeddingProvider();
    f.failNext = 1;
    await expect(f.embedQuery('x')).rejects.toThrow();
    expect(await f.embedQuery('x')).toBeDefined();
  });
});
