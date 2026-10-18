import { randomUUID } from 'node:crypto';
import { classifyError } from '../../../resilience/errors.js';
import { HealthReport, healthReport, type HealthCheckable } from '../../../resilience/health.js';
import type { IngestionResult, VectorStoreAdapter } from '../../types.js';
import { ingestDocument, type IngestionOptions, type IngestionProgress } from '../ingestion.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface IngestionJob {
  id: string;
  userId: string;
  sourceId: string;
  status: JobStatus;
  /** Latest progress reported by the running task. */
  progress?: IngestionProgress;
  result?: IngestionResult;
  error?: { message: string; retryable: boolean };
  /** Runs started so far (a retryable failure schedules another attempt). */
  attempts: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** When the next attempt starts, while waiting to retry. */
  nextAttemptAt?: number;
}

export interface JobContext {
  signal: AbortSignal;
  /** Report progress (forward it to `ingestDocument`'s `onProgress`). */
  report(progress: IngestionProgress): void;
  /** 1-based number of this run. */
  attempt: number;
  /** Total runs allowed. A failure on `attempt === maxAttempts` is final (nothing will retry it). */
  maxAttempts: number;
}

export type IngestionTask = (context: JobContext) => Promise<IngestionResult>;

export interface IngestionQueueOptions {
  /** Jobs running at the same time (default 2). */
  concurrency?: number;
  /** Jobs waiting (queued or retrying) before `enqueue` refuses new ones (default 500). */
  maxQueued?: number;
  /** Total attempts for a job whose failures are retryable (default 3). */
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Finished jobs kept for status lookups (default 500, oldest dropped first). */
  retainFinished?: number;
  /** Called on every job change. Errors thrown here are ignored. */
  onUpdate?: (job: IngestionJob) => void;
  /** Test seam. */
  now?: () => number;
}

export class QueueFullError extends Error {
  readonly retryable = true;
  constructor() {
    super('The ingestion queue is full. Please try again shortly.');
    this.name = 'QueueFullError';
  }
}

interface Entry {
  job: IngestionJob;
  task: IngestionTask;
  controller: AbortController;
  notBefore: number;
}

/**
 * In-process background runner for ingestion, so an upload can return immediately (202) while chunking and
 * embedding continue, and the client polls the job (or the host pushes `onUpdate` over a stream).
 *
 * - Bounded concurrency and a bounded backlog (`QueueFullError` → tell the client to retry).
 * - Jobs of the same source never run at the same time (re-index and delete cannot interleave).
 * - Retryable failures (rate limit, timeout, outage) are retried with backoff; others fail fast.
 * - Per-tenant lookups: `get`/`list`/`cancel` require the owning `userId`, a foreign job id looks like a missing one.
 * - State is in memory: jobs are lost on restart, which is safe because ingestion is idempotent and a document
 *   left `processing` can simply be re-enqueued (resumes where it stopped).
 */
export class IngestionQueue implements HealthCheckable {
  readonly componentName = 'ingestion-queue';
  private readonly entries = new Map<string, Entry>();
  private readonly finished: string[] = [];
  private running = 0;
  private closed = false;
  private idleWaiters: { settled: () => boolean; resolve: () => void }[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly o: Required<Pick<IngestionQueueOptions, 'concurrency' | 'maxQueued' | 'maxAttempts' | 'retryBaseDelayMs' | 'retryMaxDelayMs' | 'retainFinished'>> &
    Pick<IngestionQueueOptions, 'onUpdate' | 'now'>;

  constructor(options: IngestionQueueOptions = {}) {
    this.o = {
      concurrency: Math.max(1, options.concurrency ?? 2),
      maxQueued: options.maxQueued ?? 500,
      maxAttempts: Math.max(1, options.maxAttempts ?? 3),
      retryBaseDelayMs: options.retryBaseDelayMs ?? 2_000,
      retryMaxDelayMs: options.retryMaxDelayMs ?? 60_000,
      retainFinished: options.retainFinished ?? 500,
      onUpdate: options.onUpdate,
      now: options.now,
    };
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** Queue arbitrary work that produces an `IngestionResult`. */
  enqueue(userId: string, sourceId: string, task: IngestionTask): IngestionJob {
    if (this.closed) throw new Error('The ingestion queue has been shut down.');
    if (!userId || !sourceId) throw new Error('userId and sourceId are required.');
    const waiting = [...this.entries.values()].filter((e) => e.job.status === 'queued').length;
    if (waiting >= this.o.maxQueued) throw new QueueFullError();
    const job: IngestionJob = { id: randomUUID(), userId, sourceId, status: 'queued', attempts: 0, createdAt: this.now() };
    this.entries.set(job.id, { job, task, controller: new AbortController(), notBefore: 0 });
    this.emit(job);
    this.pump();
    return { ...job };
  }

  /** Convenience: queue `ingestDocument(text, store, options)`; progress and cancellation are wired up. */
  enqueueIngestion(text: string, store: VectorStoreAdapter, options: IngestionOptions): IngestionJob {
    return this.enqueue(options.userId, options.sourceId, (ctx) =>
      ingestDocument(text, store, { ...options, signal: ctx.signal, onProgress: (p) => { ctx.report(p); options.onProgress?.(p); } }),
    );
  }

  get(userId: string, jobId: string): IngestionJob | undefined {
    const e = this.entries.get(jobId);
    return e && e.job.userId === userId ? { ...e.job } : undefined;
  }

  /** The user's jobs, newest first. */
  list(userId: string, filter: { sourceId?: string; status?: JobStatus } = {}): IngestionJob[] {
    return [...this.entries.values()]
      .map((e) => e.job)
      .filter((j) => j.userId === userId && (!filter.sourceId || j.sourceId === filter.sourceId) && (!filter.status || j.status === filter.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({ ...j }));
  }

  /** Cancels a queued or running job. Returns false for unknown / foreign / finished jobs. */
  cancel(userId: string, jobId: string): boolean {
    const e = this.entries.get(jobId);
    if (!e || e.job.userId !== userId) return false;
    if (e.job.status === 'queued') {
      this.finish(e, 'cancelled');
      return true;
    }
    if (e.job.status === 'running') {
      e.controller.abort();
      return true;
    }
    return false;
  }

  /**
   * Resolves when nothing is queued or running, or, with `filter`, when no job of that user (and source) is
   * active. Lets a caller (e.g. delete) wait for a cancelled job to actually stop before touching its data.
   */
  whenIdle(filter?: { userId: string; sourceId?: string }): Promise<void> {
    const settled = () => this.isIdle(filter);
    if (settled()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push({ settled, resolve }));
  }

  /** Stops accepting work, cancels queued jobs, aborts running ones and waits for them to settle. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const e of this.entries.values()) {
      if (e.job.status === 'queued') this.finish(e, 'cancelled');
      else if (e.job.status === 'running') e.controller.abort();
    }
    await this.whenIdle();
  }

  async checkHealth(): Promise<HealthReport> {
    const jobs = [...this.entries.values()].map((e) => e.job);
    const queued = jobs.filter((j) => j.status === 'queued').length;
    const running = jobs.filter((j) => j.status === 'running').length;
    const detail = `${running} running, ${queued} queued`;
    if (this.closed) return healthReport('down', 'shut down');
    return queued >= this.o.maxQueued ? healthReport('degraded', `${detail} (full)`) : healthReport('up', detail);
  }

  private isIdle(filter?: { userId: string; sourceId?: string }): boolean {
    if (!filter) return this.running === 0 && ![...this.entries.values()].some((e) => e.job.status === 'queued');
    return ![...this.entries.values()].some(
      (e) => e.job.userId === filter.userId && (!filter.sourceId || e.job.sourceId === filter.sourceId) && (e.job.status === 'queued' || e.job.status === 'running'),
    );
  }

  private emit(job: IngestionJob): void {
    try {
      this.o.onUpdate?.({ ...job });
    } catch {
      /* observers must not break the queue */
    }
  }

  private finish(e: Entry, status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>): void {
    e.job.status = status;
    e.job.finishedAt = this.now();
    e.job.nextAttemptAt = undefined;
    this.finished.push(e.job.id);
    while (this.finished.length > this.o.retainFinished) this.entries.delete(this.finished.shift()!);
    this.emit(e.job);
    this.resolveIdle();
  }

  private resolveIdle(): void {
    const ready = this.idleWaiters.filter((w) => w.settled());
    if (ready.length === 0) return;
    this.idleWaiters = this.idleWaiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const now = this.now();
    const busySources = new Set([...this.entries.values()].filter((e) => e.job.status === 'running').map((e) => `${e.job.userId}\0${e.job.sourceId}`));
    let nextWake: number | undefined;
    for (const e of this.entries.values()) {
      if (this.running >= this.o.concurrency) break;
      if (e.job.status !== 'queued') continue;
      const key = `${e.job.userId}\0${e.job.sourceId}`;
      if (busySources.has(key)) continue;
      if (e.notBefore > now) {
        nextWake = Math.min(nextWake ?? Infinity, e.notBefore);
        continue;
      }
      busySources.add(key);
      void this.run(e);
    }
    if (nextWake !== undefined && !this.closed) this.timer = setTimeout(() => this.pump(), Math.max(0, nextWake - this.now()));
  }

  private async run(e: Entry): Promise<void> {
    this.running++;
    const job = e.job;
    job.status = 'running';
    job.attempts++;
    job.startedAt ??= this.now();
    job.nextAttemptAt = undefined;
    e.controller = new AbortController();
    this.emit(job);
    try {
      const result = await e.task({
        signal: e.controller.signal,
        attempt: job.attempts,
        maxAttempts: this.o.maxAttempts,
        report: (progress) => {
          job.progress = progress;
          this.emit(job);
        },
      });
      job.result = result;
      job.error = undefined;
      this.finish(e, 'succeeded');
    } catch (err) {
      const c = classifyError(err);
      if (c.kind === 'aborted' || e.controller.signal.aborted) {
        this.finish(e, 'cancelled');
      } else if (c.retryable && job.attempts < this.o.maxAttempts && !this.closed) {
        const delay = Math.min(this.o.retryMaxDelayMs, Math.max(c.retryAfterMs ?? 0, this.o.retryBaseDelayMs * 2 ** (job.attempts - 1)));
        job.status = 'queued';
        job.error = { message: c.message, retryable: true };
        job.nextAttemptAt = this.now() + delay;
        e.notBefore = job.nextAttemptAt;
        this.emit(job);
      } else {
        job.error = { message: c.message, retryable: c.retryable };
        this.finish(e, 'failed');
      }
    } finally {
      this.running--;
      this.pump();
      this.resolveIdle();
    }
  }
}
