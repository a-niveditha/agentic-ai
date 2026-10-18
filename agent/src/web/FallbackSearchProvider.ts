import { HealthReport, aggregateHealth, collectHealth, errorMessage, healthReport } from '../resilience/health.js';
import { SearchHit, SearchOptions, SearchProvider } from './SearchProvider.js';

/**
 * Tries search providers in order and returns the first successful answer. Use it to put a more reliable
 * backend (Brave, Tavily, SearXNG...) behind free-but-throttled ones such as DuckDuckGo.
 */
export class FallbackSearchProvider implements SearchProvider {
  readonly name: string;
  readonly componentName = 'search:fallback';

  constructor(private readonly providers: SearchProvider[]) {
    if (providers.length === 0) throw new Error('FallbackSearchProvider needs at least one provider.');
    this.name = providers.map((p) => p.name).join('>');
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    let lastError: unknown;
    for (const provider of this.providers) {
      if (options.signal?.aborted) break;
      try {
        return await provider.search(query, options);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`All search providers failed: ${errorMessage(lastError)}`);
  }

  /** `up` if any provider is up; `degraded` if some work; `down` only if none do. */
  async checkHealth(): Promise<HealthReport> {
    const reports = await collectHealth(this.providers);
    const statuses = Object.values(reports).map((r) => r.status);
    if (statuses.every((s) => s === 'down')) return healthReport('down', 'all search providers are down');
    return healthReport(aggregateHealth(reports) === 'up' ? 'up' : 'degraded');
  }
}
