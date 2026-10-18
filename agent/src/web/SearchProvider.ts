import type { HealthCheckable } from '../resilience/health.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  maxResults?: number;
  signal?: AbortSignal;
}

/** Extension point: any web search backend (DuckDuckGo, Brave, Tavily, SearXNG...). */
export interface SearchProvider extends HealthCheckable {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}
