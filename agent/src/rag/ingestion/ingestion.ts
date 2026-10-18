import { createHash } from 'node:crypto';
import { Document } from '@langchain/core/documents';
import { abortError, sleep } from '../../resilience/retry.js';
import { assertUserId } from '../stores/tenantGuard.js';
import type { IngestionResult, RAGDocumentMetadata, VectorStoreAdapter } from '../types.js';
import type { ChunkOptions } from './chunker.js';
import { ChunkerRegistry, createDefaultChunkerRegistry } from './chunkers/ChunkerRegistry.js';
import type { Chunker, ChunkLocation, TextChunk } from './chunkers/types.js';
import type { ChunkEnricher, IngestionContext, TextTransformer } from './stages.js';

export type IngestionStage = 'preparing' | 'chunking' | 'embedding' | 'cleanup' | 'done';

export interface IngestionProgress {
  stage: IngestionStage;
  /** Chunks handled so far (meaningful during `embedding`). */
  done: number;
  /** Total chunks to handle (known after `chunking`). */
  total: number;
}

export type DuplicatePolicy = 'allow' | 'skip' | 'error';

export interface IngestionOptions extends ChunkOptions {
  userId: string;
  sourceId: string;
  title?: string;
  sourceUrl?: string;
  mimeType?: string;
  /** Upper bound on chunks per document (guards cost / quota for huge inputs). */
  maxChunks?: number;

  /** Chunking strategy, or a registry to choose one per document type. Default: structure-aware registry. */
  chunker?: Chunker | ChunkerRegistry;
  /** Run in order on the whole text before chunking. */
  transformers?: TextTransformer[];
  /** Run in order on the chunks before embedding. */
  enrichers?: ChunkEnricher[];

  /** Chunks embedded per request to the embedding model (default 32). */
  embedBatchSize?: number;
  /** Minimum delay between embedding requests, to stay under provider rate limits (default 0). */
  minBatchIntervalMs?: number;
  /** Embed every chunk even if an identical chunk is already stored (default false). */
  forceReembed?: boolean;
  /** What to do when the same tenant already has an identical document under another source id (default `allow`). */
  onDuplicate?: DuplicatePolicy;

  signal?: AbortSignal;
  onProgress?: (progress: IngestionProgress) => void;
}

export class DuplicateDocumentError extends Error {
  constructor(public readonly duplicateOf: string) {
    super('An identical document already exists.');
    this.name = 'DuplicateDocumentError';
  }
}

const DEFAULT_EMBED_BATCH = 32;

/**
 * Deterministic chunk id. `location` (page, section, rows) is part of the id only when present, so plain text
 * keeps the same ids as before while moving a chunk to another page produces a new id and is re-embedded.
 */
export function chunkContentHash(text: string, userId: string, sourceId: string, chunkIndex: number, location?: ChunkLocation): string {
  const h = createHash('sha256').update(userId).update('\0').update(sourceId).update('\0').update(String(chunkIndex)).update('\0').update(text);
  if (location) {
    const entries = Object.entries(location).filter(([, v]) => v !== undefined);
    if (entries.length) h.update('\0').update(JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : 1))));
  }
  return h.digest('hex');
}

export function hashDocumentText(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Chunks, embeds and stores a document for one tenant.
 *
 * Pipeline: transformers → chunker (chosen by file type) → enrichers → batched embedding → store → remove stale chunks.
 *
 * - Idempotent and safe to re-run for the same source: new chunks are upserted first, then stale chunks of the
 *   previous version are removed, so a failure midway never leaves the source empty.
 * - Resumable: chunks already stored unchanged are not embedded again (when the store supports `existingChunkIds`),
 *   so retrying a failed or aborted run only pays for what is missing.
 * - Cancellable via `signal`, observable via `onProgress`, rate-limit friendly via `embedBatchSize` / `minBatchIntervalMs`.
 */
export async function ingestDocument(text: string, vectorStore: VectorStoreAdapter, options: IngestionOptions): Promise<IngestionResult> {
  assertUserId(options.userId);
  if (!options.sourceId) throw new Error('Source identity is mandatory for ingestion.');
  const { signal, onProgress } = options;
  const progress = (stage: IngestionStage, done = 0, total = 0) => {
    try {
      onProgress?.({ stage, done, total });
    } catch {
      /* a broken observer must never fail ingestion */
    }
  };
  const context: IngestionContext = { userId: options.userId, sourceId: options.sourceId, title: options.title, mimeType: options.mimeType, sourceUrl: options.sourceUrl };

  throwIfAborted(signal);
  progress('preparing');
  let processed = text;
  for (const t of options.transformers ?? []) processed = await t.transform(processed, context);

  const documentHash = hashDocumentText(processed);
  const policy = options.onDuplicate ?? 'allow';
  if (policy !== 'allow' && vectorStore.findSourceByDocHash) {
    const duplicateOf = await vectorStore.findSourceByDocHash(documentHash, options.userId, options.sourceId);
    if (duplicateOf) {
      if (policy === 'error') throw new DuplicateDocumentError(duplicateOf);
      progress('done');
      return { success: true, chunksIndexed: 0, documentIds: [], chunksRemoved: 0, chunksEmbedded: 0, chunksSkipped: 0, documentHash, chunker: 'none', duplicateOf };
    }
  }

  progress('chunking');
  const chunker =
    options.chunker && 'select' in options.chunker
      ? options.chunker.select({ mimeType: options.mimeType, filename: options.title })
      : options.chunker ?? createDefaultChunkerRegistry().select({ mimeType: options.mimeType, filename: options.title });
  let chunks: TextChunk[] = await chunker.chunk(processed, { chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap });
  for (const e of options.enrichers ?? []) chunks = await e.enrich(chunks, context);
  chunks = chunks.filter((c) => c.text.trim().length > 0);
  if (options.maxChunks && chunks.length > options.maxChunks) chunks = chunks.slice(0, options.maxChunks);

  const docs: Document<RAGDocumentMetadata>[] = chunks.map((chunk, i) => {
    const metadata: RAGDocumentMetadata = {
      userId: options.userId,
      sourceId: options.sourceId,
      contentHash: chunkContentHash(chunk.text, options.userId, options.sourceId, i, chunk.metadata),
      chunkIndex: i,
      title: options.title,
      sourceUrl: options.sourceUrl,
      mimeType: options.mimeType,
      docHash: documentHash,
      ...(chunk.metadata?.page !== undefined ? { page: chunk.metadata.page } : {}),
      ...(chunk.metadata?.section ? { section: chunk.metadata.section } : {}),
      ...(chunk.metadata?.rowStart !== undefined ? { rowStart: chunk.metadata.rowStart } : {}),
      ...(chunk.metadata?.rowEnd !== undefined ? { rowEnd: chunk.metadata.rowEnd } : {}),
    };
    return new Document({ pageContent: chunk.text, metadata });
  });
  const ids = docs.map((d) => d.metadata.contentHash);

  let existing = new Set<string>();
  if (!options.forceReembed && vectorStore.existingChunkIds && ids.length > 0) {
    try {
      existing = await vectorStore.existingChunkIds(ids, options.userId);
    } catch {
      existing = new Set(); // the lookup is an optimisation; embedding below reports the real failure if the store is down
    }
  }
  const pending = docs.filter((d) => !existing.has(d.metadata.contentHash));
  const total = docs.length;
  let done = total - pending.length;
  progress('embedding', done, total);

  const batchSize = Math.max(1, options.embedBatchSize ?? DEFAULT_EMBED_BATCH);
  const interval = options.minBatchIntervalMs ?? 0;
  let lastBatchAt = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    throwIfAborted(signal);
    const wait = lastBatchAt + interval - Date.now();
    if (lastBatchAt && wait > 0) await sleep(wait, signal);
    const batch = pending.slice(i, i + batchSize);
    lastBatchAt = Date.now();
    await vectorStore.addDocuments(batch);
    done += batch.length;
    progress('embedding', done, total);
  }

  throwIfAborted(signal);
  progress('cleanup', total, total);
  const chunksRemoved = await vectorStore.deleteBySourceId(options.sourceId, options.userId, { keepIds: ids });
  progress('done', total, total);
  return { success: true, chunksIndexed: ids.length, documentIds: ids, chunksRemoved, chunksEmbedded: pending.length, chunksSkipped: existing.size, documentHash, chunker: chunker.name };
}
