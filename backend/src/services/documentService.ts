import path from 'node:path';
import {
  AgentContext,
  DocumentSink,
  IngestionQueue,
  LoaderError,
  LoaderRegistry,
  QueueFullError,
  Scraper,
  ScrapeError,
  VectorStoreAdapter,
  classifyError,
  friendlyMessage,
  hashDocumentText,
  ingestDocument,
  type IngestionProgress,
  type IngestionResult,
} from '@agentic-ai/agent';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { DuplicateContentError, type AbstractStorageAdapter } from './AbstractStorageAdapter.js';
import type { IDocument } from './types.js';

export interface DocumentServiceDeps {
  storage: AbstractStorageAdapter;
  vectorStore: VectorStoreAdapter;
  loaders: LoaderRegistry;
  scraper: Scraper;
  logger: Logger;
  limits?: { maxDocsPerUser?: number; maxContentChars?: number; maxChunks?: number };
  ingestion?: {
    /** Documents indexed at the same time (default 2). */
    concurrency?: number;
    /** Documents waiting to be indexed before new uploads are refused with 503 `queue_full` (default 500). */
    maxQueued?: number;
    /** Chunks per embedding request (default 32). */
    embedBatchSize?: number;
    /** Minimum delay between embedding requests, for providers with tight rate limits (default 0). */
    minBatchIntervalMs?: number;
    /** Runs per document before an indexing failure is final (default 3). */
    maxAttempts?: number;
    retryBaseDelayMs?: number;
  };
}

export function safeFilename(name: string): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_').trim().slice(0, 200);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'document';
}

const LOADER_STATUS: Record<LoaderError['code'], number> = { unsupported: 415, too_large: 413, empty: 422, corrupt: 422, mismatch: 422 };

/**
 * Lifecycle of a knowledge-base document:
 *
 *   request: validate -> (fetch URL) -> reject duplicates -> row `processing` -> 202
 *   background: chunk + embed + store -> `ready` | `failed`
 *
 * Everything cheap and user-fixable (file type, size, quota, unreachable URL, duplicate content) is rejected
 * synchronously; the slow, outage-prone part (embedding) runs in the background queue, and the outcome is
 * visible as the document's `status` / `errorMessage`.
 */
export class DocumentService implements DocumentSink {
  private readonly maxDocs: number;
  private readonly maxChars: number;
  private readonly maxChunks: number;
  private readonly queue: IngestionQueue;

  constructor(private readonly deps: DocumentServiceDeps) {
    this.maxDocs = deps.limits?.maxDocsPerUser ?? 200;
    this.maxChars = deps.limits?.maxContentChars ?? 1_500_000;
    this.maxChunks = deps.limits?.maxChunks ?? 1_500;
    const o = deps.ingestion ?? {};
    this.queue = new IngestionQueue({ concurrency: o.concurrency, maxQueued: o.maxQueued, maxAttempts: o.maxAttempts, retryBaseDelayMs: o.retryBaseDelayMs });
  }

  supportedExtensions(): string[] {
    return this.deps.loaders.supportedExtensions();
  }

  list(userId: string): Promise<IDocument[]> {
    return this.deps.storage.listDocuments(userId);
  }

  async get(userId: string, id: string): Promise<IDocument> {
    const doc = await this.deps.storage.getDocument(userId, id);
    if (!doc) throw notFound('Document');
    return doc;
  }

  /** Resolves when no document is waiting to be indexed or being indexed (tests, graceful shutdown). */
  whenIdle(): Promise<void> {
    return this.queue.whenIdle();
  }

  /** Stops background indexing. Documents still `processing` can be re-indexed with `retry`. */
  shutdown(): Promise<void> {
    return this.queue.shutdown();
  }

  /** Returns the document with status `processing`; indexing continues in the background. */
  async uploadFile(userId: string, file: { buffer: Buffer; originalname: string; mimetype?: string }): Promise<IDocument> {
    const filename = safeFilename(file.originalname);
    await this.assertQuota(userId);
    let loaded;
    try {
      loaded = await this.deps.loaders.load({ buffer: file.buffer, filename, mimeType: file.mimetype });
    } catch (err) {
      if (err instanceof LoaderError) throw new AppError(LOADER_STATUS[err.code], `file_${err.code}`, err.message);
      throw err;
    }
    return this.createAndQueue(userId, { filename, mimeType: file.mimetype || 'application/octet-stream', text: loaded.text });
  }

  async addText(userId: string, input: { title: string; text: string; mimeType?: string; sourceUrl?: string | null }): Promise<IDocument> {
    return this.createAndQueue(userId, await this.prepareText(userId, input));
  }

  async addUrl(userId: string, url: string, signal?: AbortSignal): Promise<IDocument> {
    await this.assertQuota(userId);
    let page;
    try {
      page = await this.deps.scraper.scrape(url, { signal, maxChars: 80_000 });
    } catch (err) {
      if (err instanceof ScrapeError) {
        const status = { blocked: 400, invalid_url: 400, unsupported_content: 415, timeout: 504, http_error: 502, network: 502, too_many_redirects: 502, aborted: 499 }[err.code] ?? 502;
        throw new AppError(status, `url_${err.code}`, err.message);
      }
      throw err;
    }
    if (page.markdown.trim().length < 20) throw new AppError(422, 'file_empty', 'The page has no readable text.');
    return this.createAndQueue(userId, { filename: safeFilename(page.title || new URL(page.url).hostname), mimeType: 'text/markdown', sourceUrl: page.url, text: page.markdown });
  }

  /** Re-runs chunking/embedding from the stored text (after a failure, or for a document left `processing` by a restart). */
  async retry(userId: string, id: string): Promise<IDocument> {
    const doc = await this.get(userId, id);
    if (this.queue.list(userId, { sourceId: id }).some((j) => j.status === 'queued' || j.status === 'running')) {
      throw conflict('This document is already being processed.', 'already_processing');
    }
    const text = await this.deps.storage.getDocumentContent(userId, id);
    if (!text) throw new AppError(409, 'content_unavailable', 'The original text is no longer stored; please upload the document again.');
    const processing = (await this.deps.storage.updateDocument(userId, id, { status: 'processing', errorMessage: null })) ?? { ...doc, status: 'processing' as const, errorMessage: null };
    this.enqueueIndexing(userId, processing, text);
    return processing;
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.get(userId, id); // 404 for foreign / missing ids
    // Stop any indexing of this document and let it finish stopping, so it cannot write vectors after we delete them.
    for (const job of this.queue.list(userId, { sourceId: id })) this.queue.cancel(userId, job.id);
    await this.queue.whenIdle({ userId, sourceId: id });
    try {
      await this.deps.vectorStore.deleteBySourceId(id, userId);
    } catch (err) {
      // Keep the row so the user can retry the delete; never report success while vectors may remain.
      this.deps.logger.error({ err, documentId: id }, 'vector deletion failed');
      throw new AppError(503, 'service_unavailable', 'The knowledge base is temporarily unavailable; the document was not deleted. Please retry.', undefined, { 'Retry-After': '5' });
    }
    await this.deps.storage.deleteDocument(userId, id);
  }

  /**
   * DocumentSink: used by the agent's save_to_knowledge_base tool. Identity comes from the trusted context.
   * Unlike uploads it indexes before returning, because the model reports the outcome and may search it next.
   */
  async saveText(context: AgentContext, doc: { title: string; text: string; sourceUrl?: string; mimeType?: string }) {
    const userId = context.tenantId;
    const prepared = await this.prepareText(userId, { title: doc.title, text: doc.text, sourceUrl: doc.sourceUrl, mimeType: doc.mimeType });
    const row = await this.createRow(userId, prepared);
    try {
      const result = await this.runIngestion(userId, row, prepared.text);
      return { documentId: row.id, chunksIndexed: result.chunksIndexed };
    } catch (err) {
      const reason = await this.markFailed(userId, row.id, err);
      throw new AppError(503, 'indexing_failed', `${reason} The document was saved but is not searchable yet; retry with POST /api/v1/documents/${row.id}/retry.`, { document: { ...row, status: 'failed', errorMessage: reason } }, { 'Retry-After': '10' });
    }
  }

  // ---- internals ------------------------------------------------------------------------------------------

  private async prepareText(userId: string, input: { title: string; text: string; mimeType?: string; sourceUrl?: string | null }) {
    const text = input.text.trim();
    if (!text) throw new AppError(422, 'file_empty', 'There is no text to add.');
    await this.assertQuota(userId);
    return { filename: safeFilename(input.title), mimeType: input.mimeType ?? 'text/plain', sourceUrl: input.sourceUrl ?? null, text };
  }

  private async assertQuota(userId: string): Promise<void> {
    if ((await this.deps.storage.countDocuments(userId)) >= this.maxDocs) {
      throw new AppError(403, 'quota_exceeded', `Document limit reached (${this.maxDocs}). Delete some documents first.`);
    }
  }

  /** Validates size and uniqueness and stores the row (`processing`). Rejects identical content with 409. */
  private async createRow(userId: string, input: { filename: string; mimeType: string; sourceUrl?: string | null; text: string }): Promise<IDocument> {
    if (input.text.length > this.maxChars) throw new AppError(413, 'file_too_large', `The document has too much text (limit ${this.maxChars} characters).`);
    const contentHash = hashDocumentText(input.text);
    const duplicate = async () => {
      const existing = await this.deps.storage.findDocumentByContentHash(userId, contentHash);
      return new AppError(409, 'duplicate_document', 'An identical document is already in your knowledge base.', { duplicateOf: existing?.id, document: existing ?? undefined });
    };
    if (await this.deps.storage.findDocumentByContentHash(userId, contentHash)) throw await duplicate();
    try {
      return await this.deps.storage.createDocument(userId, { filename: input.filename, mimeType: input.mimeType, sourceUrl: input.sourceUrl, content: input.text, contentHash });
    } catch (err) {
      if (err instanceof DuplicateContentError) throw await duplicate(); // lost a race with an identical concurrent upload
      throw err;
    }
  }

  private async createAndQueue(userId: string, input: { filename: string; mimeType: string; sourceUrl?: string | null; text: string }): Promise<IDocument> {
    const row = await this.createRow(userId, input);
    try {
      this.enqueueIndexing(userId, row, input.text);
    } catch (err) {
      await this.deps.storage.deleteDocument(userId, row.id).catch(() => false); // nothing was queued, so do not leave a row that will never be processed
      throw err;
    }
    return row;
  }

  private enqueueIndexing(userId: string, doc: IDocument, text: string): void {
    try {
      this.queue.enqueue(userId, doc.id, async (ctx) => {
        try {
          return await this.runIngestion(userId, doc, text, ctx.signal, ctx.report);
        } catch (err) {
          const c = classifyError(err);
          const isFinal = !c.retryable || ctx.attempt >= ctx.maxAttempts;
          if (c.kind !== 'aborted' && isFinal) await this.markFailed(userId, doc.id, err);
          throw err; // the queue retries retryable failures with backoff, and records cancellations
        }
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        throw new AppError(503, 'queue_full', 'Too many documents are being processed right now. Please try again shortly.', undefined, { 'Retry-After': '10' });
      }
      throw err;
    }
  }

  /** Chunk, embed and store; marks the document `ready`. Throws on failure (the caller decides how to surface it). */
  private async runIngestion(userId: string, doc: IDocument, text: string, signal?: AbortSignal, onProgress?: (p: IngestionProgress) => void): Promise<IngestionResult> {
    const o = this.deps.ingestion ?? {};
    const result = await ingestDocument(text, this.deps.vectorStore, {
      userId,
      sourceId: doc.id,
      title: doc.filename,
      sourceUrl: doc.sourceUrl ?? undefined,
      mimeType: doc.mimeType,
      maxChunks: this.maxChunks,
      embedBatchSize: o.embedBatchSize,
      minBatchIntervalMs: o.minBatchIntervalMs,
      signal,
      onProgress,
    });
    await this.deps.storage.updateDocument(userId, doc.id, { status: 'ready', chunksCount: result.chunksIndexed, errorMessage: null });
    return result;
  }

  /** Records a final failure on the document with a user-safe reason (never the raw provider error). */
  private async markFailed(userId: string, documentId: string, err: unknown): Promise<string> {
    const kind = classifyError(err).kind;
    const reason = friendlyMessage(kind === 'unknown' ? 'unavailable' : kind, 'The indexing service');
    this.deps.logger.error({ err, documentId }, 'document indexing failed');
    await this.deps.storage.updateDocument(userId, documentId, { status: 'failed', errorMessage: reason }).catch(() => null);
    return reason;
  }
}

export { badRequest };
