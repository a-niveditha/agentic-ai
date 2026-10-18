import { describe, expect, it } from 'bun:test';
import { ctx } from '../../tools/__tests__/helpers.js';
import { WebScrapeTool } from '../../tools/builtins/WebScrapeTool.js';
import { WebSearchTool } from '../../tools/builtins/WebSearchTool.js';
import { DuckDuckGoSearchProvider } from '../DuckDuckGoSearchProvider.js';
import { HttpScraper } from '../HttpScraper.js';
import { ScrapeError } from '../Scraper.js';

describe('live web: search + scrape', () => {
  it('scrapes a real public page into clean markdown', async () => {
    const page = await new HttpScraper().scrape('https://example.com/');
    expect(page.markdown).toContain('Example Domain');
    expect(page.contentType).toBe('text/html');
    expect(page.url).toMatch(/^https:\/\/example\.com/);
    expect(page.markdown).not.toMatch(/<html|<script/i);
  }, 60_000);

  it('follows a real redirect (http -> https)', async () => {
    const page = await new HttpScraper().scrape('http://example.com/');
    expect(page.markdown).toContain('Example Domain');
  }, 60_000);

  it('reports a real 404 as a clean error', async () => {
    const err = await new HttpScraper({ retries: 0 }).scrape('https://example.com/definitely-not-a-page-xyz').catch((e) => e);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(err.status).toBe(404);
  }, 60_000);

  it('SSRF with REAL DNS: a public hostname that resolves to 127.0.0.1 is blocked before any connection', async () => {
    const err = await new HttpScraper({ retries: 0 }).scrape('http://localtest.me/').catch((e) => e);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(err.code).toBe('blocked');
  }, 60_000);

  it('SSRF: loopback, metadata and RFC1918 literals are blocked', async () => {
    const s = new HttpScraper({ retries: 0 });
    for (const url of ['http://127.0.0.1:80/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/', 'http://[::1]/', 'http://0.0.0.0/']) {
      const err = await s.scrape(url).catch((e) => e);
      expect({ url, code: err.code }).toEqual({ url, code: 'blocked' });
    }
  }, 60_000);

  it('DuckDuckGo: returns usable results, or fails gracefully (it rate-limits anonymous scrapers)', async () => {
    const provider = new DuckDuckGoSearchProvider();
    const out = await provider.search('Model Context Protocol specification', { maxResults: 5 }).then(
      (hits) => ({ hits, error: undefined as Error | undefined }),
      (error: Error) => ({ hits: [], error }),
    );
    if (out.error) {
      console.warn(`[web.int] DuckDuckGo unavailable (${out.error.message.slice(0, 80)}); verifying graceful degradation instead`);
      expect(out.error.message.length).toBeGreaterThan(0);
      // the tool surfaces it as a retryable, friendly error rather than throwing
      const r = await new WebSearchTool(provider).execute({ query: 'x' }, ctx());
      expect(r.ok).toBe(false);
      expect(r.error!.retryable).toBe(true);
      return;
    }
    expect(out.hits.length).toBeGreaterThan(0);
    for (const h of out.hits) {
      expect(h.url).toMatch(/^https?:\/\//);
      expect(h.title.length).toBeGreaterThan(0);
      expect(h.title).not.toMatch(/<[^>]+>/);
    }
  }, 120_000);

  it('web tools compose: scrape tool returns fenced content + a citation for a real page', async () => {
    const r = await new WebScrapeTool(new HttpScraper()).execute({ url: 'https://example.com/' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('<untrusted url="https://example.com/"');
    expect(r.content).toContain('Example Domain');
    expect(r.citations[0]!.url).toBe('https://example.com/');
  }, 60_000);
});
