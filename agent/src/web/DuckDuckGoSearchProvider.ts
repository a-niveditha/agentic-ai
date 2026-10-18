import { SafeSearchType, search as ddgSearch } from 'duck-duck-scrape';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { HealthReport } from '../resilience/health.js';
import { RetryOptions, resilientCall } from '../resilience/retry.js';
import { SearchHit, SearchOptions, SearchProvider } from './SearchProvider.js';

export type DdgSearchFn = (query: string) => Promise<{ results: { title: string; url: string; description?: string; rawDescription?: string }[] }>;

export interface DuckDuckGoOptions {
  retry?: RetryOptions;
  breaker?: CircuitBreaker;
  /** Test seam. */
  searchFn?: DdgSearchFn;
}

export function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly name = 'duckduckgo';
  readonly componentName = 'search:duckduckgo';
  readonly breaker: CircuitBreaker;
  private readonly retry: RetryOptions;
  private readonly searchFn: DdgSearchFn;

  constructor(options: DuckDuckGoOptions = {}) {
    // DuckDuckGo throttles anonymous scrapers aggressively: back off generously and open the circuit quickly.
    this.retry = options.retry ?? { retries: 2, baseDelayMs: 1_500, maxDelayMs: 8_000, isRetryable: () => true };
    this.breaker = options.breaker ?? new CircuitBreaker({ name: this.componentName, failureThreshold: 3, cooldownMs: 60_000, isServiceFailure: () => true });
    this.searchFn = options.searchFn ?? ((q) => ddgSearch(q, { safeSearch: SafeSearchType.MODERATE }) as any);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const max = Math.min(Math.max(1, options.maxResults ?? 5), 10);
    const res = await resilientCall(this.breaker, () => this.searchFn(query), { ...this.retry, signal: options.signal });
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const r of res.results ?? []) {
      if (!/^https?:\/\//i.test(r.url) || seen.has(r.url)) continue;
      seen.add(r.url);
      hits.push({ title: stripHtml(r.title), url: r.url, snippet: stripHtml(r.rawDescription ?? r.description ?? '') });
      if (hits.length >= max) break;
    }
    return hits;
  }

  async checkHealth(): Promise<HealthReport> {
    return this.breaker.checkHealth();
  }
}
