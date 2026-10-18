import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { HealthReport, healthReport } from '../resilience/health.js';
import { withRetry } from '../resilience/retry.js';
import { htmlToMarkdown } from '../rag/loaders/htmlToMarkdown.js';
import { ScrapeError, ScrapeOptions, ScrapedPage, Scraper } from './Scraper.js';
import { SsrfError, SsrfGuard, UrlGuard } from './ssrf.js';

export interface HttpScraperOptions {
  guard?: UrlGuard;
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  userAgent?: string;
  retries?: number;
  /** Test seam: lets tests talk to a local server without weakening the production guard. */
  allowedContentTypes?: string[];
}

const DEFAULT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json', 'text/xml', 'application/xml'];

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

export class HttpScraper implements Scraper {
  readonly componentName = 'scraper:http';
  private readonly guard: UrlGuard;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxChars: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;
  private readonly retries: number;
  private readonly allowedTypes: string[];

  constructor(options: HttpScraperOptions = {}) {
    this.guard = options.guard ?? new SsrfGuard();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.maxChars = options.maxChars ?? 30_000;
    this.maxRedirects = options.maxRedirects ?? 4;
    this.userAgent = options.userAgent ?? 'Mozilla/5.0 (compatible; AgenticAI-Scraper/1.0)';
    this.retries = options.retries ?? 1;
    this.allowedTypes = options.allowedContentTypes ?? DEFAULT_TYPES;
  }

  async scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapedPage> {
    try {
      return await withRetry(() => this.scrapeOnce(url, options), {
        retries: this.retries,
        baseDelayMs: 400,
        signal: options.signal,
        isRetryable: (e) => e instanceof ScrapeError && e.retryable,
      });
    } catch (err) {
      if (!(err instanceof ScrapeError) && (err as Error)?.name === 'AbortError') throw new ScrapeError('aborted', 'Cancelled.');
      throw err;
    }
  }

  private async scrapeOnce(startUrl: string, options: ScrapeOptions): Promise<ScrapedPage> {
    let current = startUrl;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      let target;
      try {
        target = await this.guard.check(current);
      } catch (err) {
        if (err instanceof SsrfError) {
          throw new ScrapeError(err.reason === 'invalid_url' ? 'invalid_url' : 'blocked', err.message);
        }
        throw err;
      }

      const res = await this.request(target.url, target.address, target.family, options.signal);

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.location;
        if (!location) throw new ScrapeError('http_error', `Redirect (${res.status}) without a Location header.`, false, res.status);
        current = new URL(location, target.url).toString();
        continue;
      }
      if (res.status >= 400) {
        throw new ScrapeError('http_error', `The page returned HTTP ${res.status}.`, res.status >= 500 || res.status === 429, res.status);
      }

      const contentType = String(res.headers['content-type'] ?? 'text/plain').toLowerCase();
      const mime = contentType.split(';')[0]!.trim();
      if (!this.allowedTypes.includes(mime)) {
        throw new ScrapeError('unsupported_content', `Unsupported content type '${mime}'.`);
      }

      const text = decodeBody(res.body, contentType);
      let markdown: string;
      let title: string | undefined;
      if (mime === 'text/html' || mime === 'application/xhtml+xml') {
        ({ markdown, title } = htmlToMarkdown(text));
      } else if (mime === 'application/json') {
        try {
          markdown = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          markdown = text;
        }
      } else {
        markdown = text;
      }

      const limit = options.maxChars ?? this.maxChars;
      const clipped = markdown.length > limit;
      return {
        url: target.url.toString(),
        title,
        markdown: clipped ? markdown.slice(0, limit) : markdown,
        contentType: mime,
        bytesRead: res.body.length,
        truncated: res.truncated || clipped,
      };
    }
    throw new ScrapeError('too_many_redirects', 'Too many redirects.');
  }

  /** One HTTP request pinned to a pre-validated IP; body is size-capped and decompressed with a cap too. */
  private request(url: URL, address: string, family: 4 | 6, signal?: AbortSignal): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      if (signal?.aborted) return reject(new ScrapeError('aborted', 'Cancelled.'));
      const lib = url.protocol === 'https:' ? https : http;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: 'GET',
          headers: { 'User-Agent': this.userAgent, Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'gzip, deflate, br' },
          // Connect to the validated address, never re-resolve (defeats DNS rebinding).
          lookup: (_host: string, opts: any, cb: any) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        } as http.RequestOptions,
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let truncated = false;
          const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
          let source: Readable = res;
          if (encoding === 'gzip' || encoding === 'x-gzip') source = res.pipe(zlib.createGunzip());
          else if (encoding === 'deflate') source = res.pipe(zlib.createInflate());
          else if (encoding === 'br') source = res.pipe(zlib.createBrotliDecompress());

          const done = () => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }));
          source.on('data', (chunk: Buffer) => {
            if (settled) return;
            const room = this.maxBytes - total;
            if (chunk.length >= room) {
              chunks.push(chunk.subarray(0, Math.max(0, room)));
              total = this.maxBytes;
              truncated = true;
              res.destroy();
              source.destroy();
              done();
              return;
            }
            chunks.push(chunk);
            total += chunk.length;
          });
          source.on('end', done);
          source.on('error', (e) => {
            if (truncated) return done();
            finish(() => reject(new ScrapeError('network', `Failed to read the response: ${e.message}`, true)));
          });
          res.on('error', (e) => finish(() => reject(new ScrapeError('network', `Connection error: ${e.message}`, true))));
        },
      );

      const timer = setTimeout(() => {
        req.destroy();
        finish(() => reject(new ScrapeError('timeout', `The page did not respond within ${this.timeoutMs}ms.`, true)));
      }, this.timeoutMs);
      const onAbort = () => {
        req.destroy();
        finish(() => reject(new ScrapeError('aborted', 'Cancelled.')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      req.on('error', (e) => finish(() => reject(new ScrapeError('network', `Could not connect: ${e.message}`, true))));
      req.end();
    });
  }

  async checkHealth(): Promise<HealthReport> {
    return healthReport('up', 'stateless');
  }
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
