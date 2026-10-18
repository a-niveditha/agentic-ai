import { describe, expect, it } from 'bun:test';
import { toCitation, publicMetadata } from '../../retrieval/retriever.js';
import { InMemoryVectorStoreAdapter } from '../../stores/InMemoryVectorStoreAdapter.js';
import { FakeEmbeddingProvider } from '../../../testing/FakeEmbeddingProvider.js';
import { PAGE_BREAK } from '../../loaders/types.js';
import { createDefaultLoaderRegistry } from '../../loaders/LoaderRegistry.js';
import { buildPdfPages } from '../../../../../tests/helpers/fixtures.js';
import { DuplicateDocumentError, chunkContentHash, hashDocumentText, ingestDocument, type IngestionProgress } from '../ingestion.js';
import { MinLengthFilter, PiiRedactor, type ChunkEnricher, type TextTransformer } from '../stages.js';
import type { VectorStoreAdapter } from '../../types.js';

/** An in-memory store that records each addDocuments batch and can be told to fail. */
function spyStore(opts: { failOnBatch?: number; noCapabilities?: boolean } = {}) {
  const embeddings = new FakeEmbeddingProvider();
  const inner = new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata });
  const batches: number[] = [];
  const times: number[] = [];
  let calls = 0;
  const store: VectorStoreAdapter = Object.create(inner);
  store.addDocuments = async (docs) => {
    calls++;
    if (opts.failOnBatch === calls) throw Object.assign(new Error('embedding backend unavailable (503)'), { status: 503 });
    batches.push(docs.length);
    times.push(Date.now());
    return inner.addDocuments(docs);
  };
  if (opts.noCapabilities) {
    store.existingChunkIds = undefined;
    store.findSourceByDocHash = undefined;
  }
  return { store, inner, batches, times, embeddings };
}

const longText = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i} talks about subject ${i}.`).join('\n\n');
const base = { userId: 'u1', sourceId: 'd1' };

describe('ingestDocument: chunking by document type', () => {
  it('stores page numbers for PDFs and returns the chunker name', async () => {
    const { store, inner } = spyStore();
    const text = ['Alpha content of page one.', 'Beta content of page two.'].join(PAGE_BREAK);
    const res = await ingestDocument(text, store, { ...base, title: 'report.pdf', mimeType: 'application/pdf' });
    expect(res.chunker).toBe('paged');
    const hits = await inner.similaritySearch('Beta page two', 2, { userId: 'u1' });
    const beta = hits.find((h) => h.document.pageContent.includes('Beta'))!;
    expect(beta.document.metadata.page).toBe(2);
    expect(toCitation(beta)).toMatchObject({ page: 2 });
  });

  it('stores heading paths for markdown and exposes them in citations', async () => {
    const { store, inner } = spyStore();
    const md = '# Handbook\n\n## Expenses\nReceipts are required for every claim over fifty dollars, no exceptions.\n\n## Travel\nBook flights through the portal at least two weeks ahead of departure.';
    await ingestDocument(md, store, { ...base, title: 'handbook.md', mimeType: 'text/markdown', chunkSize: 100, chunkOverlap: 0 });
    const [hit] = await inner.similaritySearch('receipts expense claim', 1, { userId: 'u1' });
    expect(hit!.document.metadata.section).toBe('Handbook > Expenses');
    expect(toCitation(hit!).section).toBe('Handbook > Expenses');
  });

  it('stores row ranges for tabular data', async () => {
    const { store, inner } = spyStore();
    const rows = Array.from({ length: 20 }, (_, i) => `Row ${i + 1}: name: Person ${i + 1}; role: tester`).join('\n');
    await ingestDocument(rows, store, { ...base, title: 'staff.csv', mimeType: 'text/csv', chunkSize: 120 });
    const hits = await inner.similaritySearch('Person 20', 1, { userId: 'u1' });
    expect(hits[0]!.document.metadata).toMatchObject({ rowEnd: 20 });
  });

  it('plain text keeps the legacy deterministic id and has no structural metadata', async () => {
    const { store, inner } = spyStore();
    const res = await ingestDocument('Alpha beta gamma.', store, { ...base, title: 'a.txt' });
    expect(res.chunker).toBe('recursive');
    expect(res.documentIds[0]).toBe(chunkContentHash('Alpha beta gamma.', 'u1', 'd1', 0));
    const [hit] = await inner.similaritySearch('alpha', 1, { userId: 'u1' });
    expect('page' in hit!.document.metadata).toBe(false);
  });

  it('moving a chunk to another page changes its id (so it is re-embedded with the right page)', () => {
    expect(chunkContentHash('t', 'u', 's', 0, { page: 1 })).not.toBe(chunkContentHash('t', 'u', 's', 0, { page: 2 }));
    expect(chunkContentHash('t', 'u', 's', 0, {})).toBe(chunkContentHash('t', 'u', 's', 0));
  });

  it('an explicit chunker overrides type detection', async () => {
    const { store } = spyStore();
    const custom = { name: 'whole', supports: () => true, chunk: async (t: string) => [{ text: t }] };
    const res = await ingestDocument(longText(30), store, { ...base, chunker: custom, mimeType: 'application/pdf' });
    expect(res.chunker).toBe('whole');
    expect(res.chunksIndexed).toBe(1);
  });

  it('public metadata never exposes tenant, hashes or the document hash', async () => {
    const { store, inner } = spyStore();
    await ingestDocument('Hello world content here.', store, base);
    const [hit] = await inner.similaritySearch('hello', 1, { userId: 'u1' });
    expect(hit!.document.metadata.docHash).toBe(hashDocumentText('Hello world content here.'));
    const pub = publicMetadata(hit!.document.metadata);
    for (const k of ['userId', 'contentHash', 'docHash']) expect(k in pub).toBe(false);
  });
});

describe('loader → pipeline (real PDF)', () => {
  it('a multi-page PDF is cited by page, including after blank pages', async () => {
    const { store, inner } = spyStore();
    const pdf = buildPdfPages(['', 'The cover page lists the project codename Kestrel.', 'The budget chapter says funding is nine million.', 'The appendix lists vendors.']);
    const loaded = await createDefaultLoaderRegistry().load({ buffer: pdf, filename: 'plan.pdf', mimeType: 'application/pdf' });
    const res = await ingestDocument(loaded.text, store, { ...base, title: 'plan.pdf', mimeType: 'application/pdf' });
    expect(res.chunker).toBe('paged');
    const hits = await inner.similaritySearch('funding nine million budget', 3, { userId: 'u1' });
    expect(hits[0]!.document.metadata.page).toBe(3);
    expect(toCitation(hits[0]!).page).toBe(3);
  });
});

describe('ingestDocument: batched, paced and observable embedding', () => {
  it('embeds in batches of embedBatchSize', async () => {
    const { store, batches } = spyStore();
    const res = await ingestDocument(longText(30), store, { ...base, chunkSize: 60, chunkOverlap: 0, embedBatchSize: 8 });
    expect(res.chunksIndexed).toBeGreaterThan(16);
    expect(batches.every((b) => b <= 8)).toBe(true);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(res.chunksEmbedded);
    expect(batches.length).toBeGreaterThan(2);
  });

  it('waits minBatchIntervalMs between embedding requests', async () => {
    const { store, times } = spyStore();
    await ingestDocument(longText(18), store, { ...base, chunkSize: 60, chunkOverlap: 0, embedBatchSize: 6, minBatchIntervalMs: 60 });
    expect(times.length).toBeGreaterThan(2);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(50);
  });

  it('reports progress through every stage, ending with done', async () => {
    const { store } = spyStore();
    const events: IngestionProgress[] = [];
    await ingestDocument(longText(20), store, { ...base, chunkSize: 60, chunkOverlap: 0, embedBatchSize: 5, onProgress: (p) => events.push(p) });
    const stages = [...new Set(events.map((e) => e.stage))];
    expect(stages).toEqual(['preparing', 'chunking', 'embedding', 'cleanup', 'done']);
    const embedding = events.filter((e) => e.stage === 'embedding');
    expect(embedding.at(-1)!.done).toBe(embedding.at(-1)!.total);
    expect(embedding.map((e) => e.done)).toEqual([...embedding.map((e) => e.done)].sort((a, b) => a - b));
  });

  it('a throwing progress observer never fails ingestion', async () => {
    const { store } = spyStore();
    const res = await ingestDocument('Some text to index.', store, { ...base, onProgress: () => { throw new Error('observer bug'); } });
    expect(res.success).toBe(true);
  });
});

describe('ingestDocument: resume and incremental re-index', () => {
  it('after a failure midway, a retry embeds only the chunks that are missing', async () => {
    const opts = { ...base, chunkSize: 60, chunkOverlap: 0, embedBatchSize: 5 };
    const failing = spyStore({ failOnBatch: 3 });
    const err = await ingestDocument(longText(20), failing.store, opts).catch((e) => e);
    expect(err.message).toContain('503');
    const storedBefore = await failing.inner.countBySourceId('d1', 'u1');
    expect(storedBefore).toBe(10); // two batches of five landed

    // same underlying data, healthy store
    const healthy: VectorStoreAdapter = Object.create(failing.inner);
    const embedded: number[] = [];
    healthy.addDocuments = async (docs) => { embedded.push(docs.length); return failing.inner.addDocuments(docs); };
    const res = await ingestDocument(longText(20), healthy, opts);
    expect(res.chunksSkipped).toBe(10);
    expect(embedded.reduce((a, b) => a + b, 0)).toBe(res.chunksEmbedded);
    expect(res.chunksEmbedded + res.chunksSkipped).toBe(res.chunksIndexed);
    expect(await failing.inner.countBySourceId('d1', 'u1')).toBe(res.chunksIndexed);
  });

  it('re-indexing unchanged text embeds nothing; forceReembed embeds everything', async () => {
    const { store, embeddings } = spyStore();
    await ingestDocument(longText(10), store, base);
    const calls = embeddings.calls;
    const again = await ingestDocument(longText(10), store, base);
    expect(again).toMatchObject({ chunksEmbedded: 0, chunksRemoved: 0 });
    expect(embeddings.calls).toBe(calls);
    const forced = await ingestDocument(longText(10), store, { ...base, forceReembed: true });
    expect(forced.chunksEmbedded).toBe(forced.chunksIndexed);
  });

  it('after an edit, only changed chunks are embedded and stale ones are removed', async () => {
    const { store, inner } = spyStore();
    const v1 = ['First stable paragraph about apples.', 'Second stable paragraph about pears.', 'Third paragraph about plums.'].join('\n\n');
    const v2 = ['First stable paragraph about apples.', 'Second stable paragraph about pears.', 'Third paragraph rewritten about cherries.'].join('\n\n');
    const opts = { ...base, chunkSize: 50, chunkOverlap: 0 };
    const first = await ingestDocument(v1, store, opts);
    const second = await ingestDocument(v2, store, opts);
    expect(second.chunksSkipped).toBeGreaterThan(0);
    expect(second.chunksEmbedded).toBeGreaterThan(0);
    expect(second.chunksRemoved).toBeGreaterThan(0);
    expect(await inner.countBySourceId('d1', 'u1')).toBe(second.chunksIndexed);
    expect(first.documentHash).not.toBe(second.documentHash);
    const hits = await inner.similaritySearch('plums', 5, { userId: 'u1' });
    expect(hits.some((h) => h.document.pageContent.includes('plums'))).toBe(false);
  });

  it('works with stores that lack the optional capabilities (embeds everything)', async () => {
    const { store } = spyStore({ noCapabilities: true });
    const a = await ingestDocument(longText(6), store, base);
    const b = await ingestDocument(longText(6), store, base);
    expect(b.chunksEmbedded).toBe(a.chunksIndexed);
    expect(b.chunksSkipped).toBe(0);
  });

  it('a failing capability lookup is not fatal', async () => {
    const { store } = spyStore();
    store.existingChunkIds = async () => { throw new Error('lookup down'); };
    const res = await ingestDocument('Content to index here.', store, base);
    expect(res.success).toBe(true);
  });

  it('a failed run never removes the previous version', async () => {
    const good = spyStore();
    await ingestDocument('Original version of the document text.', good.store, base);
    const broken: VectorStoreAdapter = Object.create(good.inner);
    broken.addDocuments = async () => { throw Object.assign(new Error('503'), { status: 503 }); };
    await expect(ingestDocument('Brand new different text for the doc.', broken, base)).rejects.toThrow();
    expect(await good.inner.countBySourceId('d1', 'u1')).toBe(1);
  });
});

describe('ingestDocument: cancellation', () => {
  it('rejects immediately when already aborted, touching nothing', async () => {
    const { store, batches } = spyStore();
    const c = new AbortController();
    c.abort();
    const err = await ingestDocument('text to index', store, { ...base, signal: c.signal }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(batches).toEqual([]);
  });

  it('stops between batches, keeps what was stored and does not delete the old version', async () => {
    const { store, inner } = spyStore();
    await ingestDocument('Old version text that must survive.', store, { ...base, sourceId: 'keep' });
    const c = new AbortController();
    const err = await ingestDocument(longText(30), store, { ...base, chunkSize: 60, chunkOverlap: 0, embedBatchSize: 4, signal: c.signal, onProgress: (p) => { if (p.stage === 'embedding' && p.done >= 4) c.abort(); } }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(await inner.countBySourceId('d1', 'u1')).toBeLessThan(30);
    expect(await inner.countBySourceId('keep', 'u1')).toBe(1);
  });
});

describe('ingestDocument: duplicates', () => {
  const text = 'The same document text, uploaded twice by one user.';

  it('allows duplicates by default', async () => {
    const { store, inner } = spyStore();
    await ingestDocument(text, store, base);
    const res = await ingestDocument(text, store, { ...base, sourceId: 'd2' });
    expect(res.duplicateOf).toBeUndefined();
    expect(await inner.countBySourceId('d2', 'u1')).toBe(1);
  });

  it('skip: nothing is embedded or stored, and the original is reported', async () => {
    const { store, inner, embeddings } = spyStore();
    await ingestDocument(text, store, base);
    const calls = embeddings.calls;
    const res = await ingestDocument(text, store, { ...base, sourceId: 'd2', onDuplicate: 'skip' });
    expect(res).toMatchObject({ success: true, duplicateOf: 'd1', chunksIndexed: 0, chunksEmbedded: 0 });
    expect(embeddings.calls).toBe(calls);
    expect(await inner.countBySourceId('d2', 'u1')).toBe(0);
  });

  it('error: throws DuplicateDocumentError naming the original', async () => {
    const { store } = spyStore();
    await ingestDocument(text, store, base);
    const err = await ingestDocument(text, store, { ...base, sourceId: 'd2', onDuplicate: 'error' }).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateDocumentError);
    expect(err.duplicateOf).toBe('d1');
  });

  it('re-ingesting the same source is never a duplicate of itself', async () => {
    const { store } = spyStore();
    await ingestDocument(text, store, { ...base, onDuplicate: 'error' });
    await expect(ingestDocument(text, store, { ...base, onDuplicate: 'error' })).resolves.toMatchObject({ success: true });
  });

  it('another user\'s identical document is not a duplicate (tenant isolation)', async () => {
    const { store } = spyStore();
    await ingestDocument(text, store, base);
    const res = await ingestDocument(text, store, { userId: 'u2', sourceId: 'x', onDuplicate: 'error' });
    expect(res.duplicateOf).toBeUndefined();
  });
});

describe('ingestDocument: pluggable stages', () => {
  it('transformers run in order before chunking, and the hash covers the transformed text', async () => {
    const { store, inner } = spyStore();
    const upper: TextTransformer = { name: 'upper', transform: (t) => t.toUpperCase() };
    const exclaim: TextTransformer = { name: 'exclaim', transform: async (t) => `${t}!` };
    const res = await ingestDocument('hello there', store, { ...base, transformers: [upper, exclaim] });
    const [hit] = await inner.similaritySearch('hello', 1, { userId: 'u1' });
    expect(hit!.document.pageContent).toBe('HELLO THERE!');
    expect(res.documentHash).toBe(hashDocumentText('HELLO THERE!'));
  });

  it('enrichers can drop and annotate chunks', async () => {
    const { store, inner } = spyStore();
    const text = ['1', 'A meaningful paragraph about quarterly revenue growth.'].join('\n\n');
    const tag: ChunkEnricher = { name: 'tag', enrich: (chunks) => chunks.map((c) => ({ ...c, metadata: { ...c.metadata, section: 'Tagged' } })) };
    const res = await ingestDocument(text, store, { ...base, chunkSize: 20, chunkOverlap: 0, enrichers: [new MinLengthFilter(10), tag] });
    expect(res.chunksIndexed).toBeGreaterThan(0);
    const hits = await inner.similaritySearch('revenue', 5, { userId: 'u1' });
    expect(hits.every((h) => h.document.pageContent.trim().length >= 10)).toBe(true);
    expect(hits.every((h) => h.document.metadata.section === 'Tagged')).toBe(true);
  });

  it('a failing transformer fails the ingestion without storing anything', async () => {
    const { store, inner } = spyStore();
    const boom: TextTransformer = { name: 'boom', transform: () => { throw new Error('bad stage'); } };
    await expect(ingestDocument('text', store, { ...base, transformers: [boom] })).rejects.toThrow('bad stage');
    expect(await inner.countBySourceId('d1', 'u1')).toBe(0);
  });

  it('maxChunks still caps the number of chunks', async () => {
    const { store } = spyStore();
    const res = await ingestDocument(longText(40), store, { ...base, chunkSize: 60, chunkOverlap: 0, maxChunks: 5 });
    expect(res.chunksIndexed).toBe(5);
  });

  it('empty input indexes nothing and clears the source', async () => {
    const { store, inner } = spyStore();
    await ingestDocument('something', store, base);
    const res = await ingestDocument('   ', store, base);
    expect(res).toMatchObject({ chunksIndexed: 0, chunksRemoved: 1 });
    expect(await inner.countBySourceId('d1', 'u1')).toBe(0);
  });
});

describe('PiiRedactor', () => {
  const redact = (t: string, o = {}) => new PiiRedactor(o).transform(t);

  it('redacts emails, valid card numbers, SSNs and phone numbers', () => {
    const out = redact('Mail jane.doe@example.com, card 4111 1111 1111 1111, ssn 123-45-6789, call +1 415-555-0132.');
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[CARD]');
    expect(out).toContain('[SSN]');
    expect(out).toContain('[PHONE]');
    for (const secret of ['jane.doe@example.com', '4111', '123-45-6789', '555-0132']) expect(out).not.toContain(secret);
  });

  it('leaves digit strings that are not cards or phone numbers alone', () => {
    const text = 'Order 1234567890123 shipped; invoice 2024-05-17 total 1,299.00; version 3.14.15';
    expect(redact(text)).toBe(text);
  });

  it('each category can be switched off', () => {
    const out = redact('a@b.co and 123-45-6789', { emails: false });
    expect(out).toContain('a@b.co');
    expect(out).toContain('[SSN]');
  });

  it('is usable as a pipeline stage', async () => {
    const { store, inner } = spyStore();
    await ingestDocument('Contact bob@corp.com for the report details please.', store, { ...base, transformers: [new PiiRedactor()] });
    const [hit] = await inner.similaritySearch('report', 1, { userId: 'u1' });
    expect(hit!.document.pageContent).not.toContain('bob@corp.com');
    expect(hit!.document.pageContent).toContain('[EMAIL]');
  });
});
