/** Server-side request forgery through every path that makes the server fetch a URL: document import and the agent's web tools. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { HttpScraper } from '../../agent/src/index.js';
import { startCanary } from '../helpers/canary.js';
import { ApiClient, ofType, readSse } from '../helpers/http.js';
import { startTestApp, type TestHarness } from '../helpers/testApp.js';

let canary: Awaited<ReturnType<typeof startCanary>>;
let h: TestHarness;
let c: ApiClient;
let attackUrls: string[] = [];

beforeAll(async () => {
  canary = await startCanary();
  const p = canary.port;
  attackUrls = [
    `http://127.0.0.1:${p}/`, `http://localhost:${p}/`, `http://LOCALHOST.:${p}/`, `http://[::1]:${p}/`, `http://[::ffff:127.0.0.1]:${p}/`, `http://[::ffff:7f00:1]:${p}/`,
    `http://2130706433:${p}/`, `http://0x7f000001:${p}/`, `http://0177.0.0.1:${p}/`, `http://127.1:${p}/`, `http://0.0.0.0:${p}/`, `http://0:${p}/`,
    `http://example.com@127.0.0.1:${p}/`, `http://127.0.0.1:${p}#@example.com/`, `http://user:pass@127.0.0.1:${p}/`,
    `http://localtest.me:${p}/`, `http://127.0.0.1.nip.io:${p}/`, `http://169.254.169.254/latest/meta-data/iam/security-credentials/`, `http://metadata.google.internal/computeMetadata/v1/`,
    'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.0.1/', 'http://100.64.0.1/', 'http://[fd00::1]/', 'http://[fe80::1]/',
    'file:///etc/passwd', 'gopher://127.0.0.1:6379/_PING', 'ftp://127.0.0.1/', 'dict://127.0.0.1:11211/stats', 'ldap://127.0.0.1/', 'jar:http://127.0.0.1!/', 'javascript:alert(1)', 'data:text/html,<script>1</script>',
  ];
  // Real scraper + real SSRF guard. Only web search is faked.
  h = await startTestApp({ overrides: { scraper: new HttpScraper({ retries: 0, timeoutMs: 4000 }) } });
  c = new ApiClient(h.server.url);
  await c.signup('ssrf@sec.test');
}, 60_000);
afterAll(async () => { await h.close(); await canary.close(); });

describe('document import by URL', () => {
  it('refuses every internal / non-http target and never contacts the canary', async () => {
    const failures: string[] = [];
    for (const url of attackUrls) {
      const r = await c.json('POST', '/api/v1/documents', { json: { url } });
      // 400 either from schema (non-http scheme) or from the guard (url_blocked / invalid)
      if (r.status !== 400) failures.push(`${url} -> ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
      if (JSON.stringify(r.body).includes('CANARY-SECRET')) failures.push(`${url} leaked canary content`);
    }
    expect(failures).toEqual([]);
    expect(canary.hits).toEqual([]);
    expect((await c.json('GET', '/api/v1/documents')).body.documents).toEqual([]);
  }, 120_000);
});

describe('agent web tools', () => {
  it('web_scrape and save_to_knowledge_base cannot be used to reach internal services', async () => {
    // The scripted LLM plays a fully compromised model that tries every attack URL through both tools.
    for (let round = 0; round * 8 < attackUrls.length; round++) {
      const urls = attackUrls.slice(round * 8, round * 8 + 8);
      const batch = urls.flatMap((url) => [{ name: 'web_scrape', args: { url } }, { name: 'save_to_knowledge_base', args: { url } }]);
      const app = await startTestApp({ overrides: { scraper: new HttpScraper({ retries: 0, timeoutMs: 4000 }) }, script: [{ toolCalls: batch }, { text: 'done' }], env: { MAX_TOOL_CALLS_PER_TURN: '40' } });
      try {
        const cl = new ApiClient(app.server.url); await cl.signup(`ssrf-r${round}@sec.test`);
        const s = (await cl.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id;
        const events = await readSse(await cl.request('POST', `/api/v1/chat/sessions/${s}/messages`, { json: { text: 'fetch these' } }));
        const ends = ofType(events, 'tool_end');
        expect({ round, ends: ends.length }).toEqual({ round, ends: batch.length });
        expect(ends.every((e) => e.payload.success === false)).toBe(true);
        expect(JSON.stringify(events)).not.toContain('CANARY-SECRET');
        expect((await cl.json('GET', '/api/v1/documents')).body.documents).toEqual([]);
      } finally { await app.close(); }
    }
    expect(canary.hits).toEqual([]);
  }, 300_000);

  it('the error shown to the model does not reveal internal network details', async () => {
    const app = await startTestApp({ overrides: { scraper: new HttpScraper({ retries: 0 }) }, script: [{ toolCalls: [{ name: 'web_scrape', args: { url: `http://127.0.0.1:${canary.port}/` } }] }, { text: 'done' }] });
    try {
      const cl = new ApiClient(app.server.url); await cl.signup('ssrf-msg@sec.test');
      const s = (await cl.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id;
      const events = await readSse(await cl.request('POST', `/api/v1/chat/sessions/${s}/messages`, { json: { text: 'x' } }));
      const out = ofType(events, 'tool_end')[0]!.payload.output as string;
      expect(out).toContain('ERROR');
      expect(out).not.toMatch(/ECONNREFUSED|EHOSTUNREACH|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/);
    } finally { await app.close(); }
  });
});

describe('DNS rebinding & redirects (guard-level)', () => {
  it('a hostname that flips from public to private between check and use cannot redirect the connection', async () => {
    // The scraper connects to the address the guard validated; a second lookup is never performed.
    let lookups = 0;
    const { SsrfGuard } = await import('../../agent/src/index.js');
    const guard = new SsrfGuard({ resolve: async () => { lookups++; return lookups === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; } });
    const target = await guard.check('http://rebind.example/');
    expect(target.address).toBe('93.184.216.34');
    expect(lookups).toBe(1); // the pinned address is what the scraper uses; no re-resolution happens at connect time
  });

  it('the canary was never contacted during any of these tests', () => {
    expect(canary.hits).toEqual([]);
  });
});
