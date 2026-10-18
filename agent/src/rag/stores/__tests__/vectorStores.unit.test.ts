import { describe, expect, it } from 'bun:test';
import { Document } from '@langchain/core/documents';
import { FakeEmbeddingProvider } from '../../../testing/FakeEmbeddingProvider.js';
import { ChromaVectorStoreAdapter, chromaCollectionName, type ChromaClientLike, type ChromaCollectionLike } from '../ChromaVectorStoreAdapter.js';
import { InMemoryVectorStoreAdapter, cosineSimilarity } from '../InMemoryVectorStoreAdapter.js';
import { assertUserId, dropForeignResults } from '../tenantGuard.js';
import { CircuitBreaker } from '../../../resilience/circuitBreaker.js';
import { doc, makeStore } from '../../__tests__/helpers.js';

describe('tenantGuard', () => {
  it('assertUserId rejects empty / non-string ids', () => {
    for (const bad of ['', '   ', undefined, null, 5]) expect(() => assertUserId(bad)).toThrow(/Tenant isolation/);
    expect(() => assertUserId('u1')).not.toThrow();
  });

  it('dropForeignResults filters other tenants and counts them', () => {
    const results = [
      { id: 'a', document: doc('x', 'u1', 's'), score: 1 },
      { id: 'b', document: doc('y', 'u2', 's'), score: 0.9 },
    ];
    const { safe, dropped } = dropForeignResults(results, 'u1');
    expect(safe.map((r) => r.id)).toEqual(['a']);
    expect(dropped).toBe(1);
  });
});

describe('cosineSimilarity', () => {
  it('handles identical, orthogonal, zero and mismatched vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('InMemoryVectorStoreAdapter', () => {
  it('returns the most similar chunk first with a score', async () => {
    const { store } = makeStore();
    await store.addDocuments([doc('apples and oranges grow on trees', 'u1', 's1', 0), doc('rockets use liquid hydrogen fuel', 'u1', 's2', 0)]);
    const res = await store.similaritySearch('what fuel do rockets use', 2, { userId: 'u1' });
    expect(res[0]!.document.pageContent).toContain('rockets');
    expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
  });

  it('NEVER returns another tenant\'s chunks', async () => {
    const { store } = makeStore();
    await store.addDocuments([doc('secret launch codes alpha', 'alice', 's1'), doc('public notes about launch', 'bob', 's2')]);
    const res = await store.similaritySearch('launch codes', 10, { userId: 'bob' });
    expect(res.map((r) => r.document.metadata.userId)).toEqual(['bob']);
    expect(res.some((r) => r.document.pageContent.includes('alpha'))).toBe(false);
  });

  it('requires a userId for every operation', async () => {
    const { store } = makeStore();
    await expect(store.similaritySearch('q', 3, { userId: '' })).rejects.toThrow(/Tenant isolation/);
    await expect(store.deleteBySourceId('s', '')).rejects.toThrow(/Tenant isolation/);
    await expect(store.deleteByUserId('')).rejects.toThrow(/Tenant isolation/);
    await expect(store.countBySourceId('s', '')).rejects.toThrow(/Tenant isolation/);
    await expect(store.addDocuments([doc('x', '', 's')])).rejects.toThrow(/Tenant isolation/);
  });

  it('upserts by content hash (idempotent)', async () => {
    const { store } = makeStore();
    const d = doc('same chunk', 'u1', 's1');
    await store.addDocuments([d]);
    await store.addDocuments([d]);
    expect(await store.countBySourceId('s1', 'u1')).toBe(1);
  });

  it('deleteBySourceId only touches the owner\'s source and honors keepIds', async () => {
    const { store } = makeStore();
    const a0 = doc('a zero', 'u1', 'src', 0);
    const a1 = doc('a one', 'u1', 'src', 1);
    const other = doc('a zero', 'u2', 'src', 0);
    await store.addDocuments([a0, a1, other]);
    expect(await store.deleteBySourceId('src', 'u1', { keepIds: [a0.metadata.contentHash] })).toBe(1);
    expect(await store.countBySourceId('src', 'u1')).toBe(1);
    expect(await store.countBySourceId('src', 'u2')).toBe(1); // untouched
    expect(await store.deleteBySourceId('src', 'u1')).toBe(1);
    expect(await store.deleteBySourceId('nope', 'u1')).toBe(0);
  });

  it('deleteByUserId removes only that user\'s data', async () => {
    const { store } = makeStore();
    await store.addDocuments([doc('one', 'u1', 's'), doc('two', 'u1', 's', 1), doc('three', 'u2', 's')]);
    expect(await store.deleteByUserId('u1')).toBe(2);
    expect(await store.countBySourceId('s', 'u2')).toBe(1);
  });

  it('handles k<=0 and empty adds', async () => {
    const { store } = makeStore();
    expect(await store.addDocuments([])).toEqual([]);
    await store.addDocuments([doc('x', 'u1', 's')]);
    expect(await store.similaritySearch('x', 0, { userId: 'u1' })).toEqual([]);
  });

  it('reports metadata and health', async () => {
    const { store, embeddings } = makeStore();
    expect(await store.getEmbeddingModelMetadata()).toEqual(embeddings.metadata);
    expect((await store.checkHealth()).status).toBe('up');
  });
});

// ---- Chroma adapter against an in-process fake collection ---------------------------------------------------

function fakeChroma(opts: { ignoreWhere?: boolean } = {}) {
  type Row = { id: string; embedding: number[]; document: string; metadata: Record<string, any> };
  const rows = new Map<string, Row>();
  const calls = { upsert: 0, query: 0, get: 0, delete: 0, getOrCreate: 0 };
  const matches = (m: Record<string, any>, where?: any): boolean => {
    if (!where || opts.ignoreWhere) return true;
    if (where.$and) return where.$and.every((w: any) => matches(m, w));
    return Object.entries(where).every(([k, cond]: [string, any]) => ('$ne' in cond ? m[k] !== cond.$ne : m[k] === cond.$eq));
  };
  const collection: ChromaCollectionLike = {
    async upsert({ ids, embeddings, documents, metadatas }) {
      calls.upsert++;
      ids.forEach((id, i) => rows.set(id, { id, embedding: embeddings[i]!, document: documents[i]!, metadata: metadatas[i]! }));
    },
    async query({ queryEmbeddings, nResults, where }) {
      calls.query++;
      const q = queryEmbeddings[0]!;
      const scored = [...rows.values()].filter((r) => matches(r.metadata, where)).map((r) => ({ r, d: 1 - cosineSimilarity(q, r.embedding) })).sort((a, b) => a.d - b.d).slice(0, nResults);
      return { ids: [scored.map((s) => s.r.id)], documents: [scored.map((s) => s.r.document)], metadatas: [scored.map((s) => s.r.metadata)], distances: [scored.map((s) => s.d)] };
    },
    async get({ ids, where, limit = 1000, offset = 0 }) {
      calls.get++;
      const found = [...rows.values()].filter((r) => (!ids || ids.includes(r.id)) && matches(r.metadata, where)).slice(offset, offset + limit);
      return { ids: found.map((r) => r.id), metadatas: found.map((r) => r.metadata) };
    },
    async delete({ ids }) {
      calls.delete++;
      ids?.forEach((id) => rows.delete(id));
    },
  };
  const state = { down: false, heartbeatDown: false };
  const client: ChromaClientLike = {
    async heartbeat() {
      if (state.heartbeatDown) throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
      return 1;
    },
    async getOrCreateCollection() {
      calls.getOrCreate++;
      if (state.down) throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
      return collection;
    },
  };
  return { client, rows, calls, state };
}

function chromaAdapter(opts: { ignoreWhere?: boolean; breaker?: CircuitBreaker; batch?: number } = {}) {
  const embeddings = new FakeEmbeddingProvider();
  const fake = fakeChroma(opts);
  const adapter = new ChromaVectorStoreAdapter({
    collectionName: 'kb', embeddings, metadata: embeddings.metadata, client: fake.client,
    retry: { retries: 1, baseDelayMs: 1, jitter: 0, sleep: async () => {} }, breaker: opts.breaker, upsertBatchSize: opts.batch,
  });
  return { adapter, fake, embeddings };
}

describe('ChromaVectorStoreAdapter (fake client)', () => {
  it('namespaces the collection by embedding model and dimensions', () => {
    const a = chromaCollectionName('kb', { provider: 'google', modelId: 'gemini-embedding-001', dimensions: 3072 });
    const b = chromaCollectionName('kb', { provider: 'local', modelId: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/);
    expect(b).not.toContain('/');
  });

  it('stores and retrieves with a similarity score; strips undefined metadata', async () => {
    const { adapter, fake } = chromaAdapter();
    await adapter.addDocuments([doc('rockets burn liquid hydrogen', 'u1', 's1', 0, { title: undefined })]);
    const stored = [...fake.rows.values()][0]!;
    expect('title' in stored.metadata).toBe(false);
    const res = await adapter.similaritySearch('rockets hydrogen', 3, { userId: 'u1' });
    expect(res).toHaveLength(1);
    expect(res[0]!.score).toBeGreaterThan(0.5);
    expect(res[0]!.document).toBeInstanceOf(Document);
  });

  it('applies a userId where-filter on every query', async () => {
    const { adapter } = chromaAdapter();
    await adapter.addDocuments([doc('alpha secret', 'alice', 's1'), doc('alpha public', 'bob', 's2')]);
    const res = await adapter.similaritySearch('alpha', 5, { userId: 'bob' });
    expect(res.map((r) => r.document.metadata.userId)).toEqual(['bob']);
  });

  it('defends in depth: drops foreign chunks even if the backend ignores the filter', async () => {
    const { adapter } = chromaAdapter({ ignoreWhere: true });
    await adapter.addDocuments([doc('alpha secret', 'alice', 's1'), doc('alpha public', 'bob', 's2')]);
    const res = await adapter.similaritySearch('alpha', 5, { userId: 'bob' });
    expect(res.map((r) => r.document.metadata.userId)).toEqual(['bob']);
  });

  it('upserts in batches', async () => {
    const { adapter, fake } = chromaAdapter({ batch: 2 });
    await adapter.addDocuments([0, 1, 2, 3, 4].map((i) => doc(`chunk ${i}`, 'u1', 's', i)));
    expect(fake.calls.upsert).toBe(3);
    expect(fake.rows.size).toBe(5);
  });

  it('deletes by source (honoring keepIds), by user, and counts', async () => {
    const { adapter } = chromaAdapter();
    const keep = doc('keep me', 'u1', 'src', 0);
    await adapter.addDocuments([keep, doc('old chunk', 'u1', 'src', 1), doc('other user', 'u2', 'src', 0)]);
    expect(await adapter.countBySourceId('src', 'u1')).toBe(2);
    expect(await adapter.deleteBySourceId('src', 'u1', { keepIds: [keep.metadata.contentHash] })).toBe(1);
    expect(await adapter.countBySourceId('src', 'u1')).toBe(1);
    expect(await adapter.deleteByUserId('u1')).toBe(1);
    expect(await adapter.countBySourceId('src', 'u2')).toBe(1);
  });

  it('requires userId for all operations', async () => {
    const { adapter } = chromaAdapter();
    await expect(adapter.similaritySearch('q', 1, { userId: '' })).rejects.toThrow(/Tenant isolation/);
    await expect(adapter.deleteBySourceId('s', ' ')).rejects.toThrow(/Tenant isolation/);
    await expect(adapter.addDocuments([doc('x', '', 's')])).rejects.toThrow(/Tenant isolation/);
  });

  it('degrades: construction never touches the network; tryConnect resolves false when Chroma is down, then recovers', async () => {
    const { adapter, fake } = chromaAdapter({ breaker: new CircuitBreaker({ name: 'c', failureThreshold: 100 }) });
    expect(fake.calls.getOrCreate).toBe(0);
    fake.state.down = true;
    expect(await adapter.tryConnect()).toBe(false);
    await expect(adapter.similaritySearch('q', 1, { userId: 'u1' })).rejects.toThrow(/ECONNREFUSED/);
    fake.state.down = false;
    expect(await adapter.tryConnect()).toBe(true);
    expect(await adapter.similaritySearch('q', 1, { userId: 'u1' })).toEqual([]);
  });

  it('opens its circuit after repeated failures and then fails fast', async () => {
    const breaker = new CircuitBreaker({ name: 'chroma', failureThreshold: 2, cooldownMs: 60_000 });
    const { adapter, fake } = chromaAdapter({ breaker });
    fake.state.down = true;
    await adapter.tryConnect();
    const before = fake.calls.getOrCreate;
    const err = await adapter.similaritySearch('q', 1, { userId: 'u1' }).catch((e) => e);
    expect(err.name).toBe('CircuitOpenError');
    expect(fake.calls.getOrCreate).toBe(before); // no further hammering
  });

  it('health: down when heartbeat fails, up when healthy', async () => {
    const { adapter, fake } = chromaAdapter();
    expect((await adapter.checkHealth()).status).toBe('up');
    fake.state.heartbeatDown = true;
    const h = await adapter.checkHealth();
    expect(h.status).toBe('down');
    expect(h.detail).toContain('unreachable');
  });
});

// ---- optional capabilities used by the ingestion pipeline (both adapters share one contract) ---------------------

describe.each([
  ['in-memory', () => makeStore().store],
  ['chroma (fake client)', () => chromaAdapter().adapter],
])('ingestion capabilities: %s', (_name, make) => {
  it('existingChunkIds returns only this tenant\'s stored ids', async () => {
    const store = make();
    const a = doc('alpha', 'u1', 's1', 0);
    const b = doc('beta', 'u2', 's2', 0);
    await store.addDocuments([a, b]);
    const found = await store.existingChunkIds!([a.metadata.contentHash, b.metadata.contentHash, 'nope'], 'u1');
    expect([...found]).toEqual([a.metadata.contentHash]);
    await expect(store.existingChunkIds!(['x'], '')).rejects.toThrow(/Tenant isolation/);
  });

  it('findSourceByDocHash finds an identical document of the same tenant only, ignoring the excluded source', async () => {
    const store = make();
    await store.addDocuments([doc('alpha', 'u1', 's1', 0, { docHash: 'H' }), doc('alpha', 'u2', 's9', 0, { docHash: 'H' })]);
    expect(await store.findSourceByDocHash!('H', 'u1')).toBe('s1');
    expect(await store.findSourceByDocHash!('H', 'u1', 's1')).toBeUndefined();
    expect(await store.findSourceByDocHash!('other', 'u1')).toBeUndefined();
    expect(await store.findSourceByDocHash!('H', 'u3')).toBeUndefined();
    await expect(store.findSourceByDocHash!('H', '')).rejects.toThrow(/Tenant isolation/);
  });
});
