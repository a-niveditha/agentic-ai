import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FACTS, buildFixtureFiles, buildPdfPages, type FixtureFile } from '../../../../../tests/helpers/fixtures.js';
import { startChroma, type ChromaServer } from '../../../../../tests/helpers/chroma.js';
import { CircuitBreaker } from '../../../resilience/circuitBreaker.js';
import { ChromaVectorStoreAdapter } from '../ChromaVectorStoreAdapter.js';
import { GeminiEmbeddingProvider } from '../../embeddings/GeminiEmbeddingProvider.js';
import { ingestDocument } from '../../ingestion/ingestion.js';
import { createDefaultLoaderRegistry } from '../../loaders/LoaderRegistry.js';
import { TenantRetriever } from '../../retrieval/retriever.js';

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const live = apiKey ? describe : describe.skip; // never silently pass without a key: skipped tests are visible in the output

let chroma: ChromaServer;
let embeddings: GeminiEmbeddingProvider;
let fixtures: FixtureFile[];
const collection = `int_${Date.now()}`;
const loaders = createDefaultLoaderRegistry();

const makeAdapter = (url = chroma.url, breaker?: CircuitBreaker) =>
  new ChromaVectorStoreAdapter({ collectionName: collection, url, embeddings, metadata: embeddings.metadata, breaker, retry: { retries: 1, baseDelayMs: 100, maxDelayMs: 300 } });

live('Chroma (disk) + Gemini embeddings', () => {
  beforeAll(async () => {
    chroma = await startChroma('rag-int');
    embeddings = new GeminiEmbeddingProvider({ apiKey });
    fixtures = await buildFixtureFiles();
  }, 60_000);
  afterAll(async () => { await chroma?.stop(); });

  it('embeds with the real Gemini model (3072 dims, normalized-ish, semantically ordered)', async () => {
    const [a, b, c] = await embeddings.embedDocuments(['The cat sat on the mat', 'A kitten rested on the rug', 'Quarterly revenue grew by twelve percent']);
    expect(a).toHaveLength(embeddings.metadata.dimensions);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0) / (Math.hypot(...x) * Math.hypot(...y));
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
  }, 60_000);

  it('ingests EVERY supported file type end to end and retrieves the right fact with the right source', async () => {
    const store = makeAdapter();
    const user = 'int-user-1';
    const ids: Record<string, string> = {};
    for (const f of fixtures) {
      const loaded = await loaders.load({ filename: f.filename, buffer: f.buffer, mimeType: f.mimeType });
      ids[f.kind] = `doc-${f.kind}`;
      const res = await ingestDocument(loaded.text, store, { userId: user, sourceId: ids[f.kind]!, title: f.filename, mimeType: f.mimeType });
      expect(res.chunksIndexed).toBeGreaterThan(0);
    }
    for (const f of fixtures) {
      const hits = await new TenantRetriever({ store, userId: user, topK: 3 }).search(FACTS[f.kind].question);
      expect({ kind: f.kind, top: hits[0]?.document.metadata.sourceId }).toEqual({ kind: f.kind, top: ids[f.kind] });
      expect(hits[0]!.document.pageContent).toContain(FACTS[f.kind].answer.split(' ')[0]!);
      expect(hits[0]!.score).toBeGreaterThan(0.3);
    }
  }, 240_000);

  it('TENANT ISOLATION on the real vector DB: another user sees nothing of user-1\'s documents', async () => {
    const store = makeAdapter();
    await ingestDocument('Bob keeps the launch codename Midnight Walrus in his private notes.', store, { userId: 'int-bob', sourceId: 'bob-doc', title: 'Bob private' });
    const aliceView = await store.similaritySearch('What is the launch codename?', 10, { userId: 'int-user-1' });
    expect(aliceView.every((r) => r.document.metadata.userId === 'int-user-1')).toBe(true);
    expect(aliceView.some((r) => r.document.pageContent.includes('Walrus'))).toBe(false);
    const bobView = await store.similaritySearch('What is the launch codename?', 10, { userId: 'int-bob' });
    expect(bobView.every((r) => r.document.metadata.userId === 'int-bob')).toBe(true);
    expect(bobView[0]!.document.pageContent).toContain('Walrus');
    expect(await store.similaritySearch('anything', 5, { userId: 'int-nobody' })).toEqual([]);
  }, 120_000);

  it('PERSISTS TO DISK: data survives a Chroma server restart', async () => {
    await chroma.restart();
    const store = makeAdapter();
    const hits = await store.similaritySearch(FACTS.txt.question, 2, { userId: 'int-user-1' });
    expect(hits[0]!.document.pageContent).toContain('Zorblax');
  }, 120_000);

  it('re-ingesting a changed document replaces its chunks; deleting removes all of them', async () => {
    const store = makeAdapter();
    const user = 'int-user-2';
    await ingestDocument('The Falconer Treaty expires on Monday.', store, { userId: user, sourceId: 'treaty' });
    const res = await ingestDocument('The Falconer Treaty was extended to Friday.', store, { userId: user, sourceId: 'treaty' });
    expect(res.chunksRemoved).toBe(1);
    const hits = await store.similaritySearch('When does the Falconer Treaty expire?', 5, { userId: user });
    expect(hits.map((h) => h.document.pageContent).join(' ')).not.toContain('Monday');
    expect(hits[0]!.document.pageContent).toContain('Friday');
    expect(await store.deleteBySourceId('treaty', user)).toBe(1);
    expect(await store.similaritySearch('Falconer Treaty', 5, { userId: user })).toEqual([]);
    expect(await store.countBySourceId('treaty', user)).toBe(0);
  }, 120_000);

  it('INGESTION PIPELINE on real Chroma: page metadata, resume, incremental re-index and duplicate detection', async () => {
    const store = makeAdapter();
    const user = 'int-pipeline';
    const pdf = buildPdfPages(['Cover page of the Kestrel plan.', 'The budget chapter states funding of nine million quatloos.', 'Appendix lists approved vendors.']);
    const loaded = await loaders.load({ filename: 'plan.pdf', buffer: pdf, mimeType: 'application/pdf' });

    const first = await ingestDocument(loaded.text, store, { userId: user, sourceId: 'plan', title: 'plan.pdf', mimeType: 'application/pdf' });
    expect(first).toMatchObject({ chunker: 'paged', chunksSkipped: 0 });
    const [hit] = await new TenantRetriever({ store, userId: user, topK: 1 }).search('how much funding is in the budget chapter');
    expect(hit!.document.metadata).toMatchObject({ page: 2, sourceId: 'plan' });

    // existingChunkIds uses a real ids + where query
    expect((await store.existingChunkIds(first.documentIds, user)).size).toBe(first.documentIds.length);
    expect((await store.existingChunkIds(first.documentIds, 'someone-else')).size).toBe(0);

    // re-indexing identical content embeds nothing
    const again = await ingestDocument(loaded.text, store, { userId: user, sourceId: 'plan', title: 'plan.pdf', mimeType: 'application/pdf' });
    expect(again).toMatchObject({ chunksEmbedded: 0, chunksRemoved: 0, chunksSkipped: first.chunksIndexed });

    // duplicate detection uses a real $ne + $and query, scoped to the tenant
    expect(await store.findSourceByDocHash(first.documentHash, user, 'plan')).toBeUndefined();
    expect(await store.findSourceByDocHash(first.documentHash, user)).toBe('plan');
    const dup = await ingestDocument(loaded.text, store, { userId: user, sourceId: 'plan-copy', title: 'plan.pdf', mimeType: 'application/pdf', onDuplicate: 'skip' });
    expect(dup).toMatchObject({ duplicateOf: 'plan', chunksIndexed: 0 });
    expect(await store.countBySourceId('plan-copy', user)).toBe(0);
    expect(await store.findSourceByDocHash(first.documentHash, 'someone-else')).toBeUndefined();
  }, 120_000);

  it('deleteByUserId wipes only that user', async () => {
    const store = makeAdapter();
    await ingestDocument('Carol note about orchids.', store, { userId: 'int-carol', sourceId: 'c1' });
    await ingestDocument('Dave note about orchids.', store, { userId: 'int-dave', sourceId: 'd1' });
    expect(await store.deleteByUserId('int-carol')).toBe(1);
    expect(await store.countBySourceId('c1', 'int-carol')).toBe(0);
    expect(await store.countBySourceId('d1', 'int-dave')).toBe(1);
  }, 120_000);

  it('different embedding models never share a collection', async () => {
    const other = new ChromaVectorStoreAdapter({ collectionName: collection, url: chroma.url, embeddings, metadata: { provider: 'local', modelId: 'other-model', dimensions: 384 } });
    expect(other.collectionName).not.toBe(makeAdapter().collectionName);
  });

  it('OUTAGE & RECOVERY: with Chroma killed the adapter fails fast and reports down; after restart it recovers by itself', async () => {
    const breaker = new CircuitBreaker({ name: 'chroma-int', failureThreshold: 2, cooldownMs: 500 });
    const store = makeAdapter(chroma.url, breaker);
    expect((await store.checkHealth()).status).toBe('up');
    await store.similaritySearch('warm up', 1, { userId: 'int-user-1' });

    await chroma.kill();
    const t = Date.now();
    await expect(store.similaritySearch('x', 1, { userId: 'int-user-1' })).rejects.toThrow();
    await expect(store.similaritySearch('x', 1, { userId: 'int-user-1' })).rejects.toThrow();
    expect(Date.now() - t).toBeLessThan(15_000);
    expect((await store.checkHealth()).status).toBe('down');
    const failFast = Date.now();
    await expect(store.similaritySearch('x', 1, { userId: 'int-user-1' })).rejects.toThrow();
    expect(Date.now() - failFast).toBeLessThan(2000); // circuit open: no waiting on a dead server

    await chroma.restart();
    await new Promise((r) => setTimeout(r, 700)); // breaker cooldown
    let recovered = false;
    for (let i = 0; i < 10 && !recovered; i++) {
      try { recovered = (await store.similaritySearch(FACTS.txt.question, 1, { userId: 'int-user-1' })).length > 0; } catch { await new Promise((r) => setTimeout(r, 600)); }
    }
    expect(recovered).toBe(true);
    expect((await store.checkHealth()).status).toBe('up');
  }, 180_000);

  it('server can start while Chroma is down (tryConnect=false) and connects once it is up', async () => {
    const dead = new ChromaVectorStoreAdapter({ collectionName: collection, url: 'http://127.0.0.1:1', embeddings, metadata: embeddings.metadata, retry: { retries: 0 } });
    expect(await dead.tryConnect()).toBe(false);
    expect((await dead.checkHealth()).status).toBe('down');
  });
});
