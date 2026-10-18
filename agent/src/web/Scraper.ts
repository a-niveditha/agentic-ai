import type { HealthCheckable } from '../resilience/health.js';

export type ScrapeErrorCode =
  | 'blocked'
  | 'invalid_url'
  | 'http_error'
  | 'timeout'
  | 'unsupported_content'
  | 'network'
  | 'too_many_redirects'
  | 'aborted';

export class ScrapeError extends Error {
  constructor(public readonly code: ScrapeErrorCode, message: string, public readonly retryable = false, public readonly status?: number) {
    super(message);
    this.name = 'ScrapeError';
  }
}

export interface ScrapedPage {
  /** Final URL after redirects. */
  url: string;
  title?: string;
  markdown: string;
  contentType: string;
  bytesRead: number;
  /** True when the page body or the extracted text was cut at the configured limit. */
  truncated: boolean;
}

export interface ScrapeOptions {
  signal?: AbortSignal;
  maxChars?: number;
}

/** Extension point: fetch one URL and return readable text. Implementations MUST defend against SSRF. */
export interface Scraper extends HealthCheckable {
  scrape(url: string, options?: ScrapeOptions): Promise<ScrapedPage>;
}
