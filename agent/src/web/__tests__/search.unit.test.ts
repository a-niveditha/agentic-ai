import { describe, expect, it } from 'bun:test';
import { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import { DuckDuckGoSearchProvider, stripHtml, type DdgSearchFn } from '../DuckDuckGoSearchProvider.js';
import { FallbackSearchProvider } from '../FallbackSearchProvider.js';
import type { SearchProvider } from '../SearchProvider.js';
import { healthReport } from '../../resilience/health.js';

const fast = { retries: 2, baseDelayMs: 1, jitter: 0, sleep: async () => {}, isRetryable: () => true };
const results = (n: number) => ({ results: Array.from({ length: n }, (_, i) => ({ title: `T${i}`, url: `https://s.test/${i}`, description: `<b>d</b> ${i}`, rawDescription: `raw ${i}` })) });

describe('stripHtml', () => {
  it('removes tags, decodes entities and collapses whitespace', () => {
    expect(stripHtml('A <b>bold</b>  &amp; &quot;quoted&quot; &lt;x&gt; it&#039;s\n fine')).toBe('A bold & "quoted" <x> it\'s fine');
  });
});

describe('DuckDuckGoSearchProvider', () => {
  it('maps results, preferring the raw description, and caps maxResults', async () => {
    const p = new DuckDuckGoSearchProvider({ searchFn: async () => results(8), retry: fast });
    const hits = await p.search('widgets', { maxResults: 3 });
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({ title: 'T0', url: 'https://s.test/0', snippet: 'raw 0' });
  });

  it('clamps maxResults to 1..10', async () => {
    const p = new DuckDuckGoSearchProvider({ searchFn: async () => results(20), retry: fast });
    expect(await p.search('q', { maxResults: 0 })).toHaveLength(1);
    expect(await p.search('q', { maxResults: 99 })).toHaveLength(10);
  });

  it('drops non-http(s) URLs and duplicates', async () => {
    const fn: DdgSearchFn = async () => ({
      results: [
        { title: 'a', url: 'https://x.test/1', description: 'a' },
        { title: 'dup', url: 'https://x.test/1', description: 'dup' },
        { title: 'js', url: 'javascript:alert(1)', description: 'x' },
        { title: 'file', url: 'file:///etc/passwd', description: 'x' },
        { title: 'ok', url: 'http://y.test/', description: 'y' },
      ],
    });
    const hits = await new DuckDuckGoSearchProvider({ searchFn: fn, retry: fast }).search('q');
    expect(hits.map((h) => h.url)).toEqual(['https://x.test/1', 'http://y.test/']);
  });

  it('falls back to the HTML description and strips tags', async () => {
    const fn: DdgSearchFn = async () => ({ results: [{ title: '<i>Hi</i>', url: 'https://x.test', description: '<b>bold</b> text' }] });
    const [hit] = await new DuckDuckGoSearchProvider({ searchFn: fn, retry: fast }).search('q');
    expect(hit).toEqual({ title: 'Hi', url: 'https://x.test', snippet: 'bold text' });
  });

  it('handles empty/missing results', async () => {
    const p = new DuckDuckGoSearchProvider({ searchFn: async () => ({}) as any, retry: fast });
    expect(await p.search('q')).toEqual([]);
  });

  it('retries DuckDuckGo anomaly/rate-limit errors then succeeds', async () => {
    let n = 0;
    const p = new DuckDuckGoSearchProvider({ searchFn: async () => { if (++n < 3) throw new Error('DDG detected an anomaly in the request'); return results(1); }, retry: fast });
    expect(await p.search('q')).toHaveLength(1);
    expect(n).toBe(3);
  });

  it('opens its circuit after repeated failures and fails fast (no hammering)', async () => {
    let n = 0;
    const breaker = new CircuitBreaker({ name: 'ddg', failureThreshold: 3, cooldownMs: 60_000, isServiceFailure: () => true });
    const p = new DuckDuckGoSearchProvider({ searchFn: async () => { n++; throw new Error('anomaly'); }, retry: fast, breaker });
    await p.search('q').catch(() => {});
    const calls = n;
    const err = await p.search('q').catch((e) => e);
    expect(err.name).toBe('CircuitOpenError');
    expect(n).toBe(calls);
    expect((await p.checkHealth()).status).toBe('down');
  });

  it('honors cancellation', async () => {
    const c = new AbortController();
    c.abort();
    const p = new DuckDuckGoSearchProvider({ searchFn: async () => results(1), retry: fast });
    await expect(p.search('q', { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function stub(name: string, behavior: () => Promise<any[]>, health: 'up' | 'down' = 'up'): SearchProvider & { calls: number } {
  const p = { name, componentName: `search:${name}`, calls: 0, async search() { p.calls++; return behavior(); }, async checkHealth() { return healthReport(health); } };
  return p;
}
const hit = (t: string) => [{ title: t, url: `https://${t}.test`, snippet: t }];

describe('FallbackSearchProvider', () => {
  it('uses the first provider when it works (second is never called)', async () => {
    const a = stub('a', async () => hit('a')); const b = stub('b', async () => hit('b'));
    expect((await new FallbackSearchProvider([a, b]).search('q'))[0]!.title).toBe('a');
    expect(b.calls).toBe(0);
  });
  it('falls back when the primary fails (e.g. DuckDuckGo anomaly)', async () => {
    const a = stub('ddg', async () => { throw new Error('DDG detected an anomaly'); }); const b = stub('brave', async () => hit('b'));
    expect((await new FallbackSearchProvider([a, b]).search('q'))[0]!.title).toBe('b');
    expect(a.calls).toBe(1);
  });
  it('throws the last error when every provider fails', async () => {
    const a = stub('a', async () => { throw new Error('first'); }); const b = stub('b', async () => { throw new Error('second'); });
    await expect(new FallbackSearchProvider([a, b]).search('q')).rejects.toThrow('second');
  });
  it('does not mask cancellation by trying the next provider', async () => {
    const a = stub('a', async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }); const b = stub('b', async () => hit('b'));
    await expect(new FallbackSearchProvider([a, b]).search('q')).rejects.toMatchObject({ name: 'AbortError' });
    expect(b.calls).toBe(0);
  });
  it('requires at least one provider and names itself after its members', () => {
    expect(() => new FallbackSearchProvider([])).toThrow();
    expect(new FallbackSearchProvider([stub('a', async () => []), stub('b', async () => [])]).name).toBe('a>b');
  });
  it('health: up if all up, degraded if some down, down only if all down', async () => {
    const up = stub('u', async () => []); const down = stub('d', async () => [], 'down');
    expect((await new FallbackSearchProvider([up, up]).checkHealth()).status).toBe('up');
    expect((await new FallbackSearchProvider([down, up]).checkHealth()).status).toBe('degraded');
    expect((await new FallbackSearchProvider([down, down]).checkHealth()).status).toBe('down');
  });
});
