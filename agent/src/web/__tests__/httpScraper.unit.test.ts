import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import http from 'node:http';
import zlib from 'node:zlib';
import { HttpScraper } from '../HttpScraper.js';
import { ScrapeError } from '../Scraper.js';
import { SsrfGuard, type UrlGuard } from '../ssrf.js';

let server: http.Server;
let port = 0;
const hits: { path: string; host?: string; ua?: string }[] = [];

const ARTICLE = '<html><head><title>Widget Weekly</title></head><body><nav>menu</nav><article><h1>Widgets</h1><p>' + 'Widgets are small mechanical gadgets used everywhere. '.repeat(5) + '</p></article><script>steal()</script></body></html>';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    hits.push({ path: url.pathname, host: req.headers.host, ua: req.headers['user-agent'] });
    switch (url.pathname) {
      case '/article': res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return void res.end(ARTICLE);
      case '/text': res.writeHead(200, { 'content-type': 'text/plain' }); return void res.end('plain body');
      case '/json': res.writeHead(200, { 'content-type': 'application/json' }); return void res.end('{"a":1}');
      case '/latin1': res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }); return void res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      case '/gzip': res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return void res.end(zlib.gzipSync('zipped hello'));
      case '/deflate': res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'deflate' }); return void res.end(zlib.deflateSync('deflated hello'));
      case '/br': res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' }); return void res.end(zlib.brotliCompressSync('brotli hello'));
      case '/gzipbomb': res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return void res.end(zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61)));
      case '/big': res.writeHead(200, { 'content-type': 'text/plain' }); return void res.end('x'.repeat(500_000));
      case '/binary': res.writeHead(200, { 'content-type': 'application/octet-stream' }); return void res.end(Buffer.from([1, 2, 3]));
      case '/image': res.writeHead(200, { 'content-type': 'image/png' }); return void res.end(Buffer.from([1, 2, 3]));
      case '/404': res.writeHead(404, { 'content-type': 'text/plain' }); return void res.end('missing');
      case '/500': res.writeHead(500); return void res.end('oops');
      case '/flaky': { const n = hits.filter((h) => h.path === '/flaky').length; if (n === 1) { res.writeHead(503); return void res.end(); } res.writeHead(200, { 'content-type': 'text/plain' }); return void res.end('recovered'); }
      case '/redirect': res.writeHead(302, { location: '/article' }); return void res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return void res.end();
      case '/redirect-private': res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return void res.end();
      case '/redirect-file': res.writeHead(302, { location: 'file:///etc/passwd' }); return void res.end();
      case '/redirect-nolocation': res.writeHead(302); return void res.end();
      case '/slow': return; // never responds
      case '/drop': return void req.socket.destroy();
      default: res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

/** Test guard: lets the loopback test server through, but applies the REAL guard to everything else (e.g. redirects). */
function guardAllowingLocal(): UrlGuard {
  const real = new SsrfGuard();
  return {
    async check(raw) {
      let u: URL | undefined;
      try { u = new URL(raw); } catch { /* the real guard reports invalid URLs */ }
      if (u && u.hostname === '127.0.0.1' && u.port === String(port)) return { url: u, address: '127.0.0.1', family: 4 };
      if (u && u.hostname === 'pinned.example') return { url: u, address: '127.0.0.1', family: 4 }; // pretend DNS resolved here
      return real.check(raw);
    },
  };
}
const base = () => `http://127.0.0.1:${port}`;
const scraper = (o: ConstructorParameters<typeof HttpScraper>[0] = {}) => new HttpScraper({ guard: guardAllowingLocal(), retries: 0, ...o });
const failure = async (p: Promise<unknown>) => (await p.catch((e) => e)) as ScrapeError;

describe('HttpScraper', () => {
  it('fetches an HTML page, extracts main content as markdown, drops scripts/nav', async () => {
    const page = await scraper().scrape(`${base()}/article`);
    expect(page.markdown).toContain('# Widgets');
    expect(page.markdown).toContain('mechanical gadgets');
    expect(page.markdown).not.toContain('steal()');
    expect(page.title).toBeTruthy();
    expect(page.contentType).toBe('text/html');
    expect(page.truncated).toBe(false);
    expect(page.url).toBe(`${base()}/article`);
  });

  it('sends an identifying user agent', async () => {
    hits.length = 0;
    await scraper({ userAgent: 'TestBot/9' }).scrape(`${base()}/text`);
    expect(hits[0]!.ua).toBe('TestBot/9');
  });

  it('handles plain text, JSON (pretty-printed) and charset decoding', async () => {
    expect((await scraper().scrape(`${base()}/text`)).markdown).toBe('plain body');
    expect((await scraper().scrape(`${base()}/json`)).markdown).toContain('"a": 1');
    expect((await scraper().scrape(`${base()}/latin1`)).markdown).toBe('café');
  });

  it('decompresses gzip, deflate and brotli responses', async () => {
    expect((await scraper().scrape(`${base()}/gzip`)).markdown).toBe('zipped hello');
    expect((await scraper().scrape(`${base()}/deflate`)).markdown).toBe('deflated hello');
    expect((await scraper().scrape(`${base()}/br`)).markdown).toBe('brotli hello');
  });

  it('caps DECOMPRESSED size (gzip bomb) and marks the page truncated instead of exhausting memory', async () => {
    const page = await scraper({ maxBytes: 100_000 }).scrape(`${base()}/gzipbomb`);
    expect(page.bytesRead).toBeLessThanOrEqual(100_000);
    expect(page.truncated).toBe(true);
  });

  it('truncates oversized bodies rather than rejecting them', async () => {
    const page = await scraper({ maxBytes: 10_000 }).scrape(`${base()}/big`);
    expect(page.truncated).toBe(true);
    expect(page.bytesRead).toBe(10_000);
  });

  it('truncates extracted text to maxChars', async () => {
    const page = await scraper().scrape(`${base()}/big`, { maxChars: 500 });
    expect(page.markdown).toHaveLength(500);
    expect(page.truncated).toBe(true);
  });

  it('rejects non-text content types', async () => {
    expect((await failure(scraper().scrape(`${base()}/binary`))).code).toBe('unsupported_content');
    expect((await failure(scraper().scrape(`${base()}/image`))).code).toBe('unsupported_content');
  });

  it('maps HTTP errors (4xx permanent, 5xx retryable)', async () => {
    const e404 = await failure(scraper().scrape(`${base()}/404`));
    expect(e404).toMatchObject({ code: 'http_error', status: 404, retryable: false });
    const e500 = await failure(scraper().scrape(`${base()}/500`));
    expect(e500).toMatchObject({ code: 'http_error', status: 500, retryable: true });
  });

  it('retries transient failures once', async () => {
    hits.length = 0;
    const page = await new HttpScraper({ guard: guardAllowingLocal(), retries: 1 }).scrape(`${base()}/flaky`);
    expect(page.markdown).toBe('recovered');
    expect(hits.filter((h) => h.path === '/flaky')).toHaveLength(2);
  });

  it('follows redirects (each hop re-validated) and reports the final URL', async () => {
    const page = await scraper().scrape(`${base()}/redirect`);
    expect(page.url).toBe(`${base()}/article`);
    expect(page.markdown).toContain('Widgets');
  });

  it('SSRF: a redirect to the cloud metadata IP is blocked', async () => {
    const e = await failure(scraper().scrape(`${base()}/redirect-private`));
    expect(e.code).toBe('blocked');
  });

  it('SSRF: a redirect to file:// is blocked', async () => {
    expect((await failure(scraper().scrape(`${base()}/redirect-file`))).code).toBe('blocked');
  });

  it('SSRF: the production guard blocks the loopback server itself', async () => {
    const e = await failure(new HttpScraper({ retries: 0 }).scrape(`${base()}/article`));
    expect(e.code).toBe('blocked');
  });

  it('SSRF: private targets never receive a request', async () => {
    hits.length = 0;
    await failure(new HttpScraper({ retries: 0 }).scrape(`http://127.0.0.1:${port}/article`));
    expect(hits).toHaveLength(0);
  });

  it('stops redirect loops and bad redirects', async () => {
    expect((await failure(scraper({ maxRedirects: 3 }).scrape(`${base()}/loop`))).code).toBe('too_many_redirects');
    expect((await failure(scraper().scrape(`${base()}/redirect-nolocation`))).code).toBe('http_error');
  });

  it('rejects invalid URLs', async () => {
    expect((await failure(scraper().scrape('not a url'))).code).toBe('invalid_url');
  });

  it('times out on unresponsive servers', async () => {
    const e = await failure(scraper({ timeoutMs: 150 }).scrape(`${base()}/slow`));
    expect(e).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('reports dropped connections as network errors', async () => {
    expect((await failure(scraper().scrape(`${base()}/drop`))).code).toBe('network');
  });

  it('honors cancellation', async () => {
    const c = new AbortController();
    const p = scraper({ timeoutMs: 5_000 }).scrape(`${base()}/slow`, { signal: c.signal });
    setTimeout(() => c.abort(), 50);
    expect((await failure(p)).code).toBe('aborted');
    const done = new AbortController();
    done.abort();
    expect((await failure(scraper().scrape(`${base()}/text`, { signal: done.signal }))).code).toBe('aborted');
  });

  it('DNS PINNING: connects to the validated address, never re-resolving the hostname', async () => {
    hits.length = 0;
    const page = await scraper().scrape(`http://pinned.example:${port}/text`);
    expect(page.markdown).toBe('plain body');
    expect(hits[0]!.host).toBe(`pinned.example:${port}`); // Host header is the name, socket went to the pinned IP
  });

  it('health is always up (stateless)', async () => {
    expect((await scraper().checkHealth()).status).toBe('up');
  });
});
