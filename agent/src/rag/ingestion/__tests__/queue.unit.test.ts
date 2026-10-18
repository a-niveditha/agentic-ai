import { describe, expect, it } from 'bun:test';
import { FakeEmbeddingProvider } from '../../../testing/FakeEmbeddingProvider.js';
import { InMemoryVectorStoreAdapter } from '../../stores/InMemoryVectorStoreAdapter.js';
import type { IngestionResult } from '../../types.js';
import { IngestionQueue, QueueFullError, type IngestionJob, type IngestionTask } from '../queue/IngestionQueue.js';

const ok: IngestionResult = { success: true, chunksIndexed: 1, documentIds: ['a'], chunksRemoved: 0, chunksEmbedded: 1, chunksSkipped: 0, documentHash: 'h', chunker: 'recursive' };
const instant: IngestionTask = async () => ok;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};

describe('IngestionQueue', () => {
  it('runs a job to success and keeps its result', async () => {
    const q = new IngestionQueue();
    const queued = q.enqueue('u1', 's1', instant);
    expect(['queued', 'running']).toContain(queued.status); // a free worker may pick it up immediately
    await q.whenIdle();
    const job = q.get('u1', queued.id)!;
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1, userId: 'u1', sourceId: 's1' });
    expect(job.result).toEqual(ok);
    expect(job.finishedAt).toBeGreaterThanOrEqual(job.createdAt);
  });

  it('forwards progress and emits an update for every change', async () => {
    const updates: IngestionJob['status'][] = [];
    const q = new IngestionQueue({ onUpdate: (j) => updates.push(j.status) });
    const job = q.enqueue('u1', 's1', async (ctx) => {
      ctx.report({ stage: 'embedding', done: 3, total: 9 });
      return ok;
    });
    await q.whenIdle();
    expect(q.get('u1', job.id)!.progress).toEqual({ stage: 'embedding', done: 3, total: 9 });
    expect(updates[0]).toBe('queued');
    expect(updates).toContain('running');
    expect(updates.at(-1)).toBe('succeeded');
  });

  it('respects the concurrency limit', async () => {
    const q = new IngestionQueue({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    const task: IngestionTask = async () => { active++; peak = Math.max(peak, active); await delay(20); active--; return ok; };
    for (let i = 0; i < 6; i++) q.enqueue('u1', `s${i}`, task);
    await q.whenIdle();
    expect(peak).toBe(2);
    expect(q.list('u1').every((j) => j.status === 'succeeded')).toBe(true);
  });

  it('never runs two jobs of the same source at once, but runs them in order', async () => {
    const q = new IngestionQueue({ concurrency: 4 });
    const order: string[] = [];
    let active = 0;
    const task = (name: string): IngestionTask => async () => { active++; expect(active).toBe(1); order.push(name); await delay(20); active--; return ok; };
    q.enqueue('u1', 'same', task('first'));
    q.enqueue('u1', 'same', task('second'));
    await q.whenIdle();
    expect(order).toEqual(['first', 'second']);
  });

  it('the same source id of different users does not block', async () => {
    const q = new IngestionQueue({ concurrency: 2 });
    let peak = 0;
    let active = 0;
    const task: IngestionTask = async () => { active++; peak = Math.max(peak, active); await delay(20); active--; return ok; };
    q.enqueue('alice', 'doc', task);
    q.enqueue('bob', 'doc', task);
    await q.whenIdle();
    expect(peak).toBe(2);
  });

  it('retries retryable failures with backoff and then succeeds', async () => {
    const q = new IngestionQueue({ retryBaseDelayMs: 10, maxAttempts: 3 });
    let calls = 0;
    const job = q.enqueue('u1', 's1', async () => {
      if (++calls < 3) throw Object.assign(new Error('rate limit (429)'), { status: 429 });
      return ok;
    });
    await q.whenIdle();
    const done = q.get('u1', job.id)!;
    expect(done).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(done.error).toBeUndefined();
  });

  it('exposes the pending retry (error and next attempt time) while waiting', async () => {
    const q = new IngestionQueue({ retryBaseDelayMs: 80, maxAttempts: 2 });
    const job = q.enqueue('u1', 's1', async () => { throw Object.assign(new Error('503 unavailable'), { status: 503 }); });
    await delay(30);
    const waiting = q.get('u1', job.id)!;
    expect(waiting.status).toBe('queued');
    expect(waiting.error?.retryable).toBe(true);
    expect(waiting.nextAttemptAt).toBeGreaterThan(Date.now() - 1);
    await q.whenIdle();
  });

  it('gives up after maxAttempts and reports the error', async () => {
    const q = new IngestionQueue({ retryBaseDelayMs: 5, maxAttempts: 2 });
    const job = q.enqueue('u1', 's1', async () => { throw Object.assign(new Error('503 unavailable'), { status: 503 }); });
    await q.whenIdle();
    expect(q.get('u1', job.id)).toMatchObject({ status: 'failed', attempts: 2, error: { retryable: true } });
  });

  it('fails fast on non-retryable errors', async () => {
    const q = new IngestionQueue({ retryBaseDelayMs: 5 });
    const job = q.enqueue('u1', 's1', async () => { throw new Error('bad input'); });
    await q.whenIdle();
    expect(q.get('u1', job.id)).toMatchObject({ status: 'failed', attempts: 1, error: { message: 'bad input', retryable: false } });
  });

  it('cancels a queued job without running it', async () => {
    const q = new IngestionQueue({ concurrency: 1 });
    const g = gate();
    q.enqueue('u1', 'a', async () => { await g.opened; return ok; });
    let ran = false;
    const second = q.enqueue('u1', 'b', async () => { ran = true; return ok; });
    expect(q.cancel('u1', second.id)).toBe(true);
    g.open();
    await q.whenIdle();
    expect(ran).toBe(false);
    expect(q.get('u1', second.id)!.status).toBe('cancelled');
  });

  it('cancels a running job through its abort signal', async () => {
    const q = new IngestionQueue();
    const started = gate();
    const job = q.enqueue('u1', 's1', (ctx) => new Promise<IngestionResult>((_, reject) => {
      started.open();
      ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    await started.opened;
    expect(q.cancel('u1', job.id)).toBe(true);
    await q.whenIdle();
    expect(q.get('u1', job.id)!.status).toBe('cancelled');
    expect(q.cancel('u1', job.id)).toBe(false); // finished jobs cannot be cancelled
  });

  it('TENANT ISOLATION: get, list and cancel only work for the owner', async () => {
    const q = new IngestionQueue({ concurrency: 1 });
    const g = gate();
    const secret = q.enqueue('alice', 'private', async () => { await g.opened; return ok; });
    expect(q.get('bob', secret.id)).toBeUndefined();
    expect(q.list('bob')).toEqual([]);
    expect(q.cancel('bob', secret.id)).toBe(false);
    expect(q.get('alice', secret.id)).toBeDefined();
    g.open();
    await q.whenIdle();
    expect(q.get('alice', secret.id)!.status).toBe('succeeded');
  });

  it('list filters by source and status, newest first', async () => {
    const q = new IngestionQueue();
    q.enqueue('u1', 'a', instant);
    await delay(3);
    q.enqueue('u1', 'b', async () => { throw new Error('x'); });
    await q.whenIdle();
    expect(q.list('u1').map((j) => j.sourceId)).toEqual(['b', 'a']);
    expect(q.list('u1', { status: 'failed' }).map((j) => j.sourceId)).toEqual(['b']);
    expect(q.list('u1', { sourceId: 'a' })).toHaveLength(1);
  });

  it('refuses new work when the backlog is full (retryable error)', async () => {
    const q = new IngestionQueue({ concurrency: 1, maxQueued: 2 });
    const g = gate();
    q.enqueue('u1', 'running', async () => { await g.opened; return ok; });
    q.enqueue('u1', 'q1', instant);
    q.enqueue('u1', 'q2', instant);
    const err = (() => { try { q.enqueue('u1', 'q3', instant); } catch (e) { return e as QueueFullError; } })();
    expect(err).toBeInstanceOf(QueueFullError);
    expect(err!.retryable).toBe(true);
    expect((await q.checkHealth()).status).toBe('degraded');
    g.open();
    await q.whenIdle();
    expect((await q.checkHealth()).status).toBe('up');
  });

  it('keeps only the most recent finished jobs', async () => {
    const q = new IngestionQueue({ retainFinished: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(q.enqueue('u1', `s${i}`, instant).id);
    await q.whenIdle();
    expect(q.list('u1')).toHaveLength(3);
    expect(q.get('u1', ids[0]!)).toBeUndefined();
    expect(q.get('u1', ids[5]!)).toBeDefined();
  });

  it('a throwing onUpdate observer never breaks the queue', async () => {
    const q = new IngestionQueue({ onUpdate: () => { throw new Error('observer bug'); } });
    const job = q.enqueue('u1', 's1', instant);
    await q.whenIdle();
    expect(q.get('u1', job.id)!.status).toBe('succeeded');
  });

  it('shutdown cancels queued jobs, aborts running ones and rejects new work', async () => {
    const q = new IngestionQueue({ concurrency: 1 });
    const started = gate();
    const running = q.enqueue('u1', 'a', (ctx) => new Promise<IngestionResult>((_, reject) => {
      started.open();
      ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const waiting = q.enqueue('u1', 'b', instant);
    await started.opened;
    await q.shutdown();
    expect(q.get('u1', running.id)!.status).toBe('cancelled');
    expect(q.get('u1', waiting.id)!.status).toBe('cancelled');
    expect(() => q.enqueue('u1', 'c', instant)).toThrow(/shut down/);
    expect((await q.checkHealth()).status).toBe('down');
  });

  it('enqueueIngestion runs the real pipeline with progress and cancellation wired up', async () => {
    const embeddings = new FakeEmbeddingProvider();
    const store = new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata });
    const q = new IngestionQueue();
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about subject ${i}.`).join('\n\n');
    const job = q.enqueueIngestion(text, store, { userId: 'u1', sourceId: 'doc', chunkSize: 60, chunkOverlap: 0, embedBatchSize: 4 });
    await q.whenIdle();
    const done = q.get('u1', job.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.result!.chunksIndexed).toBeGreaterThan(3);
    expect(done.progress).toMatchObject({ stage: 'done' });
    expect(await store.countBySourceId('doc', 'u1')).toBe(done.result!.chunksIndexed);
  });

  it('whenIdle with a filter waits only for that source; the context tells a task whether a failure is final', async () => {
    const q = new IngestionQueue({ concurrency: 2, retryBaseDelayMs: 5, maxAttempts: 2 });
    const g = gate();
    q.enqueue('u1', 'slow', async () => { await g.opened; return ok; });
    const seen: [number, number][] = [];
    q.enqueue('u1', 'fast', async (ctx) => { seen.push([ctx.attempt, ctx.maxAttempts]); if (ctx.attempt < 2) throw Object.assign(new Error('503'), { status: 503 }); return ok; });
    await q.whenIdle({ userId: 'u1', sourceId: 'fast' }); // resolves although 'slow' is still running
    expect(seen).toEqual([[1, 2], [2, 2]]);
    expect(q.list('u1', { status: 'running' }).map((j) => j.sourceId)).toEqual(['slow']);
    expect(await Promise.race([q.whenIdle({ userId: 'other' }).then(() => 'idle'), delay(20).then(() => 'blocked')])).toBe('idle');
    g.open();
    await q.whenIdle();
  });

  it('validates its inputs', () => {
    const q = new IngestionQueue();
    expect(() => q.enqueue('', 's', instant)).toThrow();
    expect(() => q.enqueue('u', '', instant)).toThrow();
  });
});
