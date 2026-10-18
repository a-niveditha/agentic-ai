# rag/ingestion/queue

> Parent: [rag/ingestion](../README.md)

An in-process background job runner for ingestion, so an upload can return immediately (`202 Accepted`) while chunking and embedding continue, and the client polls the job or the host pushes updates.

## Contract: `IngestionQueue` ([IngestionQueue.ts](IngestionQueue.ts))

```ts
const queue = new IngestionQueue({ concurrency = 2, maxQueued = 500, maxAttempts = 3,
                                   retryBaseDelayMs = 2000, retryMaxDelayMs = 60000, retainFinished = 500, onUpdate? });

queue.enqueue(userId, sourceId, task)          // task: (ctx: { signal, report, attempt, maxAttempts }) => Promise<IngestionResult>
queue.enqueueIngestion(text, store, options)   // convenience: ingestDocument with signal + progress wired up
queue.get(userId, jobId)   queue.list(userId, { sourceId?, status? })   queue.cancel(userId, jobId)
queue.whenIdle(filter?: { userId, sourceId? })   queue.shutdown()   queue.checkHealth()   // HealthCheckable ('ingestion-queue')
```

`IngestionJob`: `{ id, userId, sourceId, status: 'queued'|'running'|'succeeded'|'failed'|'cancelled', progress?, result?, error?: { message, retryable }, attempts, createdAt, startedAt?, finishedAt?, nextAttemptAt? }`. Returned objects are copies.

### Behaviour

- **Bounded.** At most `concurrency` jobs run at once; more than `maxQueued` waiting jobs makes `enqueue` throw `QueueFullError` (`retryable = true`; answer 503 + `Retry-After`).
- **Per-source ordering.** Jobs of the same `(userId, sourceId)` never run at the same time; they run in order, so re-index and delete cannot interleave.
- **Retries.** Retryable failures (rate limit, timeout, outage, as classified by `classifyError`) are retried with exponential backoff, honouring `Retry-After`, up to `maxAttempts`; the job shows `status: 'queued'` with `error` and `nextAttemptAt` while it waits. Other errors fail immediately.
- **Cancellation.** `cancel` removes a queued job or aborts a running one through `ctx.signal` (the pipeline stops between batches and keeps the previous version).
- **Tenant isolation.** `get`, `list` and `cancel` need the owner's `userId`; a foreign job id behaves like a missing one.
- **Observability.** `onUpdate` fires on every change (queued, running, each progress report, retry, finish); a throwing observer is ignored. Finished jobs are kept up to `retainFinished`, oldest dropped first.
- **Waiting.** `whenIdle()` resolves when nothing is queued or running; with `{ userId, sourceId }` it waits only for that source's jobs (used by delete to let a cancelled job stop first). A task can compare `ctx.attempt` with `ctx.maxAttempts` to know whether a failure is final.
- **Shutdown.** `shutdown()` cancels queued jobs, aborts running ones, waits for them to settle, and rejects new work.

### Limits to know about

State is in memory: jobs are lost on restart and not shared between instances. That is safe because ingestion is idempotent and resumable: after a restart, re-enqueue every document still marked `processing` and each resumes where it stopped. For multiple instances, run the queue in one worker process or replace it with a shared queue that calls `ingestDocument`.

## Tests

[`../__tests__/queue.unit.test.ts`](../__tests__/queue.unit.test.ts)
