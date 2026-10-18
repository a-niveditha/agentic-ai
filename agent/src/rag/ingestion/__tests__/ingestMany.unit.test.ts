import { describe, expect, it } from 'bun:test';
import { FakeEmbeddingProvider } from '../../../testing/FakeEmbeddingProvider.js';
import { InMemoryVectorStoreAdapter } from '../../stores/InMemoryVectorStoreAdapter.js';
import type { VectorStoreAdapter } from '../../types.js';
import { ingestMany, type IngestionItem } from '../ingestMany.js';

function makeStore(onAdd?: (docs: number) => Promise<void> | void) {
  const embeddings = new FakeEmbeddingProvider();
  const inner = new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata });
  const store: VectorStoreAdapter = Object.create(inner);
  store.addDocuments = async (docs) => {
    await onAdd?.(docs.length);
    return inner.addDocuments(docs);
  };
  return { store, inner };
}
const items = (n: number, user = 'u1'): IngestionItem[] =>
  Array.from({ length: n }, (_, i) => ({ text: `Document number ${i} describes topic ${i}.`, options: { userId: user, sourceId: `s${i}` } }));

describe('ingestMany', () => {
  it('ingests every item and reports per-item outcomes in order', async () => {
    const { store, inner } = makeStore();
    const report = await ingestMany(items(6), store);
    expect(report).toMatchObject({ succeeded: 6, failed: 0, incomplete: false });
    expect(report.outcomes.map((o) => o.sourceId)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
    expect(await inner.countBySourceId('s3', 'u1')).toBe(1);
  });

  it('never runs more documents at once than the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const { store } = makeStore(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
    });
    await ingestMany(items(10), store, { concurrency: 3 });
    expect(peak).toBe(3);
  });

  it('one failing document does not stop the others, and its error is reported', async () => {
    let n = 0;
    const { store } = makeStore(() => {
      if (++n === 2) throw Object.assign(new Error('embedding backend unavailable (503)'), { status: 503 });
    });
    const failed: string[] = [];
    const report = await ingestMany(items(5), store, { concurrency: 1, onItem: (o) => !o.ok && failed.push(o.sourceId) });
    expect(report).toMatchObject({ succeeded: 4, failed: 1, incomplete: false });
    const bad = report.outcomes.find((o) => !o.ok)!;
    expect(bad.error).toMatchObject({ retryable: true });
    expect(failed).toEqual([bad.sourceId]);
  });

  it('stopOnError stops starting new documents and marks the run incomplete', async () => {
    const { store } = makeStore(() => { throw new Error('nope'); });
    const report = await ingestMany(items(8), store, { concurrency: 1, stopOnError: true });
    expect(report.outcomes).toHaveLength(1);
    expect(report.incomplete).toBe(true);
  });

  it('aborting stops the run; completed items are kept', async () => {
    const { store, inner } = makeStore();
    const c = new AbortController();
    const report = await ingestMany(items(8), store, { concurrency: 1, signal: c.signal, onItem: (o) => o.index === 2 && c.abort() });
    expect(report.incomplete).toBe(true);
    expect(report.succeeded).toBeGreaterThanOrEqual(3);
    expect(report.succeeded).toBeLessThan(8);
    expect(await inner.countBySourceId('s0', 'u1')).toBe(1);
  });

  it('streams items from an async iterable and applies defaults', async () => {
    const { store, inner } = makeStore();
    async function* source() {
      for (const it of items(4)) yield it;
    }
    const report = await ingestMany(source(), store, { defaults: { mimeType: 'text/plain', title: 'imported' } });
    expect(report.succeeded).toBe(4);
    const [hit] = await inner.similaritySearch('topic', 1, { userId: 'u1' });
    expect(hit!.document.metadata).toMatchObject({ title: 'imported', mimeType: 'text/plain' });
  });

  it('is the re-index tool: a second run over unchanged documents embeds nothing', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const store = new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata });
    await ingestMany(items(5), store);
    const before = embeddings.calls;
    const again = await ingestMany(items(5), store);
    expect(again.outcomes.every((o) => o.result!.chunksEmbedded === 0)).toBe(true);
    expect(embeddings.calls).toBe(before);
  });

  it('keeps tenants apart', async () => {
    const { store, inner } = makeStore();
    await ingestMany([...items(2, 'alice'), ...items(2, 'bob')], store);
    expect(await inner.countBySourceId('s0', 'alice')).toBe(1);
    expect(await inner.countBySourceId('s0', 'bob')).toBe(1);
    expect(await inner.deleteByUserId('alice')).toBe(2);
    expect(await inner.countBySourceId('s0', 'bob')).toBe(1);
  });

  it('an empty input is a successful no-op', async () => {
    const { store } = makeStore();
    expect(await ingestMany([], store)).toEqual({ outcomes: [], succeeded: 0, failed: 0, incomplete: false });
  });
});
