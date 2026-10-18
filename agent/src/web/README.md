# web

> Parent: [agent/src](../README.md)

Outbound web access for the agent: search and page scraping, with SSRF protection. Used by the `web_search`, `web_scrape` and `save_to_knowledge_base` tools ([tools/builtins](../tools/builtins/README.md)) and by the backend's "add document by URL".

## Interface contracts

### `SearchProvider` ([SearchProvider.ts](SearchProvider.ts))

```ts
interface SearchHit { title: string; url: string; snippet: string }
interface SearchOptions { maxResults?: number; signal?: AbortSignal }

interface SearchProvider extends HealthCheckable {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}
```

- Throw on failure (the tool turns it into a structured "search unavailable" result). Never return partial garbage as success.
- Honour `signal`. Cap results yourself (`maxResults`).
- Add a backend (Brave, Tavily, SearXNG...) by implementing this and passing it to the backend container, optionally behind `FallbackSearchProvider`.

### `Scraper` ([Scraper.ts](Scraper.ts))

```ts
interface Scraper extends HealthCheckable {
  scrape(url: string, options?: { signal?: AbortSignal; maxChars?: number }): Promise<ScrapedPage>;
}
interface ScrapedPage { url /* final, after redirects */; title?; markdown; contentType; bytesRead; truncated }
```

- Implementations **MUST** defend against SSRF. Failures throw `ScrapeError` with a `code`: `blocked | invalid_url | http_error | timeout | unsupported_content | network | too_many_redirects | aborted` (plus `retryable` and optional HTTP `status`).
- Oversized pages are truncated (`truncated: true`), not rejected.

### `UrlGuard` / `SsrfGuard` ([ssrf.ts](ssrf.ts))

```ts
interface UrlGuard { check(rawUrl: string): Promise<{ url: URL; address: string; family: 4 | 6 }> }
```

`SsrfGuard` allows only `http(s)`, no embedded credentials, ports 80/443 (configurable), and requires **every** DNS-resolved address to be public. Refused: loopback, RFC 1918, link-local incl. `169.254.169.254`, CGNAT, documentation / benchmark / multicast / reserved IPv4 ranges, and hostnames ending in `.localhost`, `.local`, `.internal`, `.localdomain`, `.home.arpa`. IPv6 is accepted only when it is global unicast (`2000::/3`); IPv4-mapped, NAT64 and 6to4 addresses are judged by the IPv4 address they embed. It throws `SsrfError` with `reason` `invalid_url | scheme | port | credentials | private_address | dns_failure`. The caller must connect to the returned, validated `address`, so DNS cannot be rebound between check and use.

## Implementations

| Class | Notes |
|---|---|
| [`HttpScraper`](HttpScraper.ts) | Guard on every hop (redirects revalidated, max 4), connection pinned to the validated IP, 15 s timeout, 2 MB body cap, 30 000 char output cap, 1 retry, content-type allowlist (html, xhtml, plain, markdown, json, xml). HTML goes through Readability then Markdown. |
| [`DuckDuckGoSearchProvider`](DuckDuckGoSearchProvider.ts) | Free, no key. 2 retries with backoff; circuit opens after 3 failures for 60 s. May be throttled from some networks. |
| [`FallbackSearchProvider`](FallbackSearchProvider.ts) | Tries providers in order, returns the first success. Health is `up` if any is up, `degraded` if some are down, `down` only if all are. |

## Files

| File | Purpose |
|---|---|
| [SearchProvider.ts](SearchProvider.ts), [Scraper.ts](Scraper.ts) | Interfaces and error types |
| [ssrf.ts](ssrf.ts) | IP classification, `SsrfGuard` |
| [HttpScraper.ts](HttpScraper.ts) | Default scraper |
| [DuckDuckGoSearchProvider.ts](DuckDuckGoSearchProvider.ts), [FallbackSearchProvider.ts](FallbackSearchProvider.ts) | Search implementations |
| [index.ts](index.ts) | Barrel export |

## Tests

[`__tests__/`](__tests__): `ssrf`, `httpScraper`, `search` unit tests; `web.int.test.ts` hits real sites. Security regression tests: [tests/security/ssrf.sec.test.ts](../../../tests/security/ssrf.sec.test.ts).
