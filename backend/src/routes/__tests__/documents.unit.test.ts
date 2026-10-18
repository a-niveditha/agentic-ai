import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { FACTS, buildFixtureFiles, buildPdf, type FixtureFile } from '../../../../tests/helpers/fixtures.js';
import { ApiClient } from '../../../../tests/helpers/http.js';
import { startTestApp, type TestHarness } from '../../../../tests/helpers/testApp.js';
import { ScrapeError } from '../../../../agent/src/index.js';

let h: TestHarness;
let c: ApiClient;
let fixtures: FixtureFile[];
let n = 0;
beforeAll(async () => { fixtures = await buildFixtureFiles(); h = await startTestApp({ env: { MAX_UPLOAD_MB: '1', MAX_DOCS_PER_USER: '12' } }); });
afterAll(() => h.close());
beforeEach(async () => { c = new ApiClient(h.server.url); await c.signup(`doc${++n}@test.dev`); h.embeddings.failNext = 0; h.scraper.fail = undefined; });

const search = async (userId: string, q: string, k = 3) => h.deps.vectorStore.similaritySearch(q, k, { userId });
/** Holds the vector store's addDocuments until released, so a document stays `processing` for as long as a test needs. */
function holdIndexing(target: TestHarness = h) {
  const store = target.deps.vectorStore;
  const original = store.addDocuments.bind(store);
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const reachedPromise = new Promise<void>((r) => (reached = r));
  store.addDocuments = async (docs) => {
    reached();
    await released;
    return original(docs);
  };
  return { reached: reachedPromise, release: () => { release(); store.addDocuments = original; } };
}
const userId = async () => (await c.json('GET', '/api/v1/auth/me')).body.user.id as string;

describe('POST /api/v1/documents (upload)', () => {
  for (const kind of ['txt', 'md', 'pdf', 'docx', 'html', 'csv', 'json'] as const) {
    it(`indexes a .${kind} file and makes its fact retrievable`, async () => {
      const f = fixtures.find((x) => x.kind === kind)!;
      const r = await c.upload(f.filename, f.buffer, f.mimeType);
      expect(r.status).toBe(202);
      expect(r.headers.get('location')).toBe(`/api/v1/documents/${r.body.document.id}`);
      expect(r.body.document).toMatchObject({ filename: f.filename, status: 'processing', mimeType: f.mimeType, chunksCount: 0 });
      expect(r.body.document).not.toHaveProperty('content');
      expect(r.body.document).not.toHaveProperty('contentHash');
      const done = await c.waitForDocument(r.body.document.id);
      expect(done).toMatchObject({ status: 'ready', errorMessage: null });
      expect(done.chunksCount).toBeGreaterThan(0);
      const hits = await search(await userId(), FACTS[kind].question);
      expect(hits[0]!.document.pageContent).toContain(FACTS[kind].answer.split(' ')[0]!);
      expect(hits[0]!.document.metadata.sourceId).toBe(r.body.document.id);
    });
  }

  it('lists documents with supported extensions', async () => {
    await c.upload('a.txt', Buffer.from('hello list'), 'text/plain');
    const r = await c.json('GET', '/api/v1/documents');
    expect(r.body.documents).toHaveLength(1);
    expect(r.body.supportedExtensions).toEqual(expect.arrayContaining(['pdf', 'docx']));
  });

  it('rejects unsupported types (415), spoofed content (422), empty (422), corrupt (422)', async () => {
    expect((await c.upload('malware.exe', Buffer.from('MZ\u0090'), 'application/octet-stream')).status).toBe(415);
    expect((await c.upload('fake.pdf', Buffer.from('this is plain text'), 'application/pdf')).status).toBe(422);
    expect((await c.upload('disguised.txt', buildPdf('secret'), 'text/plain')).status).toBe(422);
    expect((await c.upload('empty.txt', Buffer.from('   \n'), 'text/plain')).status).toBe(422);
    expect((await c.upload('bad.json', Buffer.from('{oops'), 'application/json')).status).toBe(422);
    expect((await c.json('GET', '/api/v1/documents')).body.documents).toEqual([]); // nothing half-created
  });

  it('rejects files over the size limit (413)', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 65);
    expect((await c.upload('big.txt', big, 'text/plain')).status).toBe(413);
  });

  it('requires auth', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.txt');
    expect((await new ApiClient(h.server.url).json('POST', '/api/v1/documents', { form, auth: false })).status).toBe(401);
  });

  it('neutralizes hostile filenames (path traversal, control chars, huge names)', async () => {
    const r = await c.upload('..\\..\\etc/passwd.txt', Buffer.from('traversal test content'), 'text/plain');
    expect(r.status).toBe(202);
    expect(r.body.document.filename).toBe('passwd.txt');
    // A raw NUL in the multipart header breaks the parser: that is a client error, never a 500.
    expect((await c.upload('evil\u0000.txt', Buffer.from('x content'), 'text/plain')).status).toBeLessThan(500);
    const long = await c.upload('a'.repeat(500) + '.txt', Buffer.from('long name content'), 'text/plain');
    expect(long.body.document.filename.length).toBeLessThanOrEqual(200);
  });

  it('enforces the per-user document quota (403) without affecting other users', async () => {
    for (let i = 0; i < 12; i++) expect((await c.upload(`q${i}.txt`, Buffer.from(`quota doc ${i}`), 'text/plain')).status).toBe(202);
    const over = await c.upload('over.txt', Buffer.from('one too many'), 'text/plain');
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('quota_exceeded');
    const other = new ApiClient(h.server.url); await other.signup(`quota-other${++n}@test.dev`);
    expect((await other.upload('ok.txt', Buffer.from('fine'), 'text/plain')).status).toBe(202);
  });
});

describe('POST /api/v1/documents (text and url)', () => {
  it('indexes pasted text', async () => {
    const r = await c.json('POST', '/api/v1/documents', { json: { title: 'Notes', text: 'The Quillfeather Ledger records every lost umbrella.' } });
    expect(r.status).toBe(202);
    expect(r.body.document).toMatchObject({ filename: 'Notes', status: 'processing' });
    expect(await c.waitForDocument(r.body.document.id)).toMatchObject({ status: 'ready' });
    expect((await search(await userId(), 'lost umbrella ledger'))[0]!.document.pageContent).toContain('Quillfeather');
  });

  it('indexes a URL via the scraper and records the source url', async () => {
    h.scraper.pages.set('https://docs.test/guide', { title: 'Guide', markdown: 'The Gizmo Guide explains how to calibrate a gizmo in three steps.' });
    const r = await c.json('POST', '/api/v1/documents', { json: { url: 'https://docs.test/guide' } });
    expect(r.status).toBe(202);
    expect(r.body.document).toMatchObject({ filename: 'Guide', sourceUrl: 'https://docs.test/guide', mimeType: 'text/markdown', status: 'processing' });
    expect(await c.waitForDocument(r.body.document.id)).toMatchObject({ status: 'ready' });
    expect((await search(await userId(), 'calibrate gizmo'))[0]!.document.metadata.sourceUrl).toBe('https://docs.test/guide');
  });

  it('maps scraper failures to precise status codes', async () => {
    const cases: [ScrapeError, number][] = [
      [new ScrapeError('blocked', 'Private or reserved IP addresses are not allowed.'), 400],
      [new ScrapeError('invalid_url', 'Not a valid URL.'), 400],
      [new ScrapeError('unsupported_content', 'Unsupported content type'), 415],
      [new ScrapeError('timeout', 'slow', true), 504],
      [new ScrapeError('http_error', 'HTTP 404', false, 404), 502],
      [new ScrapeError('network', 'Could not connect', true), 502],
    ];
    for (const [err, status] of cases) {
      h.scraper.fail = err;
      expect((await c.json('POST', '/api/v1/documents', { json: { url: 'https://x.test/p' } })).status).toBe(status);
    }
  });

  it('refuses pages with no readable text', async () => {
    h.scraper.pages.set('https://x.test/empty', { markdown: ' ' });
    expect((await c.json('POST', '/api/v1/documents', { json: { url: 'https://x.test/empty' } })).status).toBe(422);
  });

  it('validates the JSON body: exactly one of text / url', async () => {
    for (const body of [{}, { text: 'a', url: 'https://x.test' }, { url: 'not a url' }, { text: '' }, { url: 'ftp://x.test/file' }]) {
      const r = await c.json('POST', '/api/v1/documents', { json: body });
      expect(r.status).toBe(400);
    }
  });

  it('blocks internal URLs through the REAL scraper guard too (defense at the API boundary)', async () => {
    const { HttpScraper } = await import('../../../../agent/src/index.js');
    const real = await startTestApp({ overrides: { scraper: new HttpScraper({ retries: 0 }) } });
    try {
      const rc = new ApiClient(real.server.url); await rc.signup('ssrf@test.dev');
      for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:5000/api/v1/health', 'http://[::1]/', 'http://10.0.0.1/']) {
        const r = await rc.json('POST', '/api/v1/documents', { json: { url } });
        expect({ url, status: r.status, code: r.body.code }).toEqual({ url, status: 400, code: 'url_blocked' });
      }
    } finally { await real.close(); }
  });
});

describe('degradation: indexing outage -> automatic retry -> failed document -> manual retry', () => {
  it('a transient embedding outage is retried automatically and the document still becomes ready', async () => {
    h.embeddings.failNext = 1;
    const r = await c.json('POST', '/api/v1/documents', { json: { title: 'Flaky', text: 'The Wobblefin Treaty ends on a Tuesday.' } });
    expect(r.status).toBe(202); // the outage is not the client's problem at request time
    expect(await c.waitForDocument(r.body.document.id)).toMatchObject({ status: 'ready', errorMessage: null });
    expect((await search(await userId(), 'Wobblefin treaty'))[0]!.document.pageContent).toContain('Wobblefin');
  });

  it('a lasting outage ends as a failed document with a safe reason; the text is kept and retry succeeds later', async () => {
    h.embeddings.failNext = 99;
    const r = await c.json('POST', '/api/v1/documents', { json: { title: 'Down', text: 'The Wobblefin Treaty ends on a Tuesday.' } });
    expect(r.status).toBe(202);
    const failed = await c.waitForDocument(r.body.document.id);
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).toBeTruthy();
    expect(failed.errorMessage).not.toMatch(/503|embedding backend/i); // never the raw provider error
    h.embeddings.failNext = 0; // the outage is over (queries need embeddings too)
    expect(await search(await userId(), 'Wobblefin treaty')).toEqual([]);

    const retry = await c.json('POST', `/api/v1/documents/${r.body.document.id}/retry`);
    expect(retry.status).toBe(202);
    expect(retry.body.document).toMatchObject({ status: 'processing', errorMessage: null });
    expect(await c.waitForDocument(r.body.document.id)).toMatchObject({ status: 'ready', errorMessage: null });
    expect((await search(await userId(), 'Wobblefin treaty'))[0]!.document.pageContent).toContain('Wobblefin');
  });

  it('retry for a document without stored text reports 409', async () => {
    const d = await h.storage.createDocument(await userId(), { filename: 'nocontent.txt', mimeType: 'text/plain', content: null });
    const r = await c.json('POST', `/api/v1/documents/${d.id}/retry`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('content_unavailable');
  });

  it('retry while the document is being processed is refused (409 already_processing)', async () => {
    const gate = holdIndexing();
    try {
      const r = await c.json('POST', '/api/v1/documents', { json: { title: 'Busy', text: 'Content that is held mid-indexing.' } });
      await gate.reached;
      const again = await c.json('POST', `/api/v1/documents/${r.body.document.id}/retry`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_processing');
    } finally { gate.release(); }
    await c.waitForIndexing();
  });

  it('a full indexing queue answers 503 queue_full with Retry-After, and leaves no half-created row', async () => {
    const small = await startTestApp({ env: { INGEST_CONCURRENCY: '1', INGEST_MAX_QUEUED: '1' } });
    const gate = holdIndexing(small);
    try {
      const sc = new ApiClient(small.server.url); await sc.signup(`full${++n}@test.dev`);
      const first = await sc.json('POST', '/api/v1/documents', { json: { title: 'one', text: 'first document body' } });
      expect(first.status).toBe(202);
      await gate.reached;
      expect((await sc.json('POST', '/api/v1/documents', { json: { title: 'two', text: 'second document body' } })).status).toBe(202); // waits in the queue
      const over = await sc.json('POST', '/api/v1/documents', { json: { title: 'three', text: 'third document body' } });
      expect(over.status).toBe(503);
      expect(over.body.code).toBe('queue_full');
      expect(over.headers.get('retry-after')).toBeTruthy();
      expect((await sc.json('GET', '/api/v1/documents')).body.documents).toHaveLength(2);
    } finally { gate.release(); await small.deps.documents.whenIdle(); await small.close(); }
  });
});

describe('duplicate content', () => {
  const body = { title: 'Original', text: 'The Plumbfern Accord was signed in a lighthouse.' };

  it('identical content is refused with 409 duplicate_document naming the existing document', async () => {
    const first = await c.json('POST', '/api/v1/documents', { json: body });
    expect(first.status).toBe(202);
    const dup = await c.json('POST', '/api/v1/documents', { json: { title: 'Renamed copy', text: `  ${body.text}\n` } }); // different title, extra whitespace
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'duplicate_document', duplicateOf: first.body.document.id });
    expect(dup.body.document.id).toBe(first.body.document.id);
    expect((await c.json('GET', '/api/v1/documents')).body.documents).toHaveLength(1);
    await c.waitForIndexing();
  });

  it('detects duplicates while the first copy is still processing, for files and URLs too', async () => {
    const gate = holdIndexing();
    try {
      const f = fixtures.find((x) => x.kind === 'txt')!;
      expect((await c.upload(f.filename, f.buffer, f.mimeType)).status).toBe(202);
      await gate.reached;
      expect((await c.upload('copy.txt', f.buffer, f.mimeType)).status).toBe(409);
    } finally { gate.release(); }
    await c.waitForIndexing();
    h.scraper.pages.set('https://dup.test/a', { title: 'A', markdown: 'The same page content served at two different addresses.' });
    h.scraper.pages.set('https://dup.test/b', { title: 'B', markdown: 'The same page content served at two different addresses.' });
    expect((await c.json('POST', '/api/v1/documents', { json: { url: 'https://dup.test/a' } })).status).toBe(202);
    expect((await c.json('POST', '/api/v1/documents', { json: { url: 'https://dup.test/b' } })).status).toBe(409);
    await c.waitForIndexing();
  });

  it('simultaneous identical uploads create exactly one document', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => c.json('POST', '/api/v1/documents', { json: body })));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect((await c.waitForIndexing())).toHaveLength(1);
  });

  it('another user may add identical content; deleting the original frees it for re-adding', async () => {
    const mine = await c.json('POST', '/api/v1/documents', { json: body });
    const other = new ApiClient(h.server.url); await other.signup(`dup-other${++n}@test.dev`);
    expect((await other.json('POST', '/api/v1/documents', { json: body })).status).toBe(202);
    await c.waitForIndexing(); await other.waitForIndexing();
    expect((await c.json('DELETE', `/api/v1/documents/${mine.body.document.id}`)).status).toBe(200);
    expect((await c.json('POST', '/api/v1/documents', { json: body })).status).toBe(202);
    await c.waitForIndexing();
  });

  it('a failed document still blocks its duplicate, and the 409 shows the failure so the client can retry it', async () => {
    h.embeddings.failNext = 99;
    const first = await c.json('POST', '/api/v1/documents', { json: body });
    await c.waitForDocument(first.body.document.id);
    const dup = await c.json('POST', '/api/v1/documents', { json: body });
    expect(dup.status).toBe(409);
    expect(dup.body.document).toMatchObject({ id: first.body.document.id, status: 'failed' });
  });
});

describe('the agent\'s save_to_knowledge_base sink', () => {
  it('indexes before returning (the model reports the outcome) and refuses duplicates', async () => {
    const uid = await userId();
    const ctx = { principalId: uid, tenantId: uid, scopes: ['kb:write'], executionId: 'e', budget: { maxToolCalls: 1, maxModelCalls: 1 } };
    const out = await h.deps.documents.saveText(ctx, { title: 'Saved', text: 'The Brindlewick lighthouse keeper logs every ship.' });
    expect(out.chunksIndexed).toBeGreaterThan(0);
    expect((await c.json('GET', `/api/v1/documents/${out.documentId}`)).body.document.status).toBe('ready');
    await expect(h.deps.documents.saveText(ctx, { title: 'Saved again', text: 'The Brindlewick lighthouse keeper logs every ship.' })).rejects.toMatchObject({ status: 409, code: 'duplicate_document' });
  });
});

describe('GET/DELETE /api/v1/documents/:id', () => {
  it('gets one document', async () => {
    const d = await c.uploadAndWait('g.txt', Buffer.from('get me'), 'text/plain');
    expect((await c.json('GET', `/api/v1/documents/${d.id}`)).body.document.id).toBe(d.id);
    expect((await c.json('GET', '/api/v1/documents/3f2b8c1e-0000-4000-8000-000000000099')).status).toBe(404);
    expect((await c.json('GET', '/api/v1/documents/not-a-uuid')).status).toBe(400);
  });

  it('delete removes the row AND the vectors (no longer retrievable)', async () => {
    const d = await c.uploadAndWait('z.txt', Buffer.from(FACTS.txt.text), 'text/plain');
    const uid = await userId();
    expect((await search(uid, FACTS.txt.question)).length).toBeGreaterThan(0);
    expect((await c.json('DELETE', `/api/v1/documents/${d.id}`)).status).toBe(200);
    expect(await search(uid, FACTS.txt.question)).toEqual([]);
    expect(await h.deps.vectorStore.countBySourceId(d.id, uid)).toBe(0);
    expect((await c.json('GET', `/api/v1/documents/${d.id}`)).status).toBe(404);
    expect((await c.json('DELETE', `/api/v1/documents/${d.id}`)).status).toBe(404);
  });

  it('deleting a document that is still being indexed cancels the work and leaves no vectors behind', async () => {
    const gate = holdIndexing();
    const r = await c.json('POST', '/api/v1/documents', { json: { title: 'Doomed', text: 'Content whose indexing is cancelled by a delete.' } });
    await gate.reached;
    const del = c.json('DELETE', `/api/v1/documents/${r.body.document.id}`);
    gate.release();
    expect((await del).status).toBe(200);
    await h.deps.documents.whenIdle();
    expect(await h.deps.vectorStore.countBySourceId(r.body.document.id, await userId())).toBe(0);
    expect((await c.json('GET', `/api/v1/documents/${r.body.document.id}`)).status).toBe(404);
  });

  it('DEGRADES: if the vector store is down the delete fails safely (503), keeping the row so it can be retried', async () => {
    const d = await c.uploadAndWait('keep.txt', Buffer.from('keep me until vectors are gone'), 'text/plain');
    const original = h.deps.vectorStore.deleteBySourceId.bind(h.deps.vectorStore);
    h.deps.vectorStore.deleteBySourceId = async () => { throw new Error('connect ECONNREFUSED'); };
    try {
      const r = await c.json('DELETE', `/api/v1/documents/${d.id}`);
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBeTruthy();
      expect((await c.json('GET', `/api/v1/documents/${d.id}`)).status).toBe(200);
    } finally { h.deps.vectorStore.deleteBySourceId = original; }
    expect((await c.json('DELETE', `/api/v1/documents/${d.id}`)).status).toBe(200);
  });
});

describe('re-index consistency', () => {
  it('retrying a ready document replaces its chunks (no duplicates)', async () => {
    const d = await c.uploadAndWait('r.txt', Buffer.from('Stable content for the reindex check.'), 'text/plain');
    expect((await c.json('POST', `/api/v1/documents/${d.id}/retry`)).status).toBe(202);
    await c.waitForDocument(d.id);
    expect(await h.deps.vectorStore.countBySourceId(d.id, await userId())).toBe(d.chunksCount);
  });
});

describe('malformed multipart requests are client errors', () => {
  it('garbage multipart bodies return 400, not 500', async () => {
    const c2 = new ApiClient(h.server.url); await c2.signup(`mp${++n}@test.dev`);
    const res = await fetch(h.server.url + '/api/v1/documents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c2.token}`, 'Content-Type': 'multipart/form-data; boundary=XXX' },
      body: '--XXX\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nBROKEN HEADER\x00\r\n\r\ndata\r\n--XXX--',
    });
    expect(res.status).toBe(400);
    const noBoundary = await fetch(h.server.url + '/api/v1/documents', { method: 'POST', headers: { Authorization: `Bearer ${c2.token}`, 'Content-Type': 'multipart/form-data' }, body: 'x' });
    expect(noBoundary.status).toBe(400);
  });
});
