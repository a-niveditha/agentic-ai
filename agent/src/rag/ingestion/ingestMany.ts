import { classifyError } from '../../resilience/errors.js';
import type { IngestionResult, VectorStoreAdapter } from '../types.js';
import { ingestDocument, type IngestionOptions } from './ingestion.js';

export interface IngestionItem {
  text: string;
  options: IngestionOptions;
}

export interface IngestionOutcome {
  index: number;
  userId: string;
  sourceId: string;
  ok: boolean;
  result?: IngestionResult;
  error?: { message: string; retryable: boolean };
}

export interface IngestManyOptions {
  /** Documents processed at the same time (default 2). */
  concurrency?: number;
  signal?: AbortSignal;
  /** Called after each document finishes, successfully or not. */
  onItem?: (outcome: IngestionOutcome) => void;
  /** Options applied to every item unless the item sets its own. */
  defaults?: Partial<Omit<IngestionOptions, 'userId' | 'sourceId'>>;
  /** Stop starting new documents after the first failure (default false: keep going and report every failure). */
  stopOnError?: boolean;
}

export interface IngestManyReport {
  outcomes: IngestionOutcome[];
  succeeded: number;
  failed: number;
  /** True when the signal aborted or `stopOnError` stopped the run before every item was handled. */
  incomplete: boolean;
}

/**
 * Ingests many documents with bounded concurrency. One failing document never blocks the rest, which makes it
 * the building block for bulk imports and for re-indexing after the embedding model changes: feed it every
 * stored document text and it only re-embeds what is missing in the (new) collection.
 * `items` may be an async iterable, so thousands of documents can be streamed from a database.
 */
export async function ingestMany(
  items: Iterable<IngestionItem> | AsyncIterable<IngestionItem>,
  vectorStore: VectorStoreAdapter,
  options: IngestManyOptions = {},
): Promise<IngestManyReport> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const iterator = (Symbol.asyncIterator in items ? (items as AsyncIterable<IngestionItem>)[Symbol.asyncIterator]() : (items as Iterable<IngestionItem>)[Symbol.iterator]()) as
    | AsyncIterator<IngestionItem>
    | Iterator<IngestionItem>;
  const outcomes: IngestionOutcome[] = [];
  let next = 0;
  let stopped = false;
  let exhausted = false;

  async function worker() {
    while (!stopped) {
      if (options.signal?.aborted) return void (stopped = true);
      const step = await iterator.next();
      if (step.done) return void (exhausted = true);
      const index = next++;
      const { text, options: itemOptions } = step.value;
      const outcome: IngestionOutcome = { index, userId: itemOptions.userId, sourceId: itemOptions.sourceId, ok: false };
      try {
        outcome.result = await ingestDocument(text, vectorStore, { ...options.defaults, signal: options.signal, ...itemOptions });
        outcome.ok = true;
      } catch (err) {
        const c = classifyError(err);
        outcome.error = { message: c.message, retryable: c.retryable || c.kind === 'aborted' };
        if (options.stopOnError) stopped = true;
      }
      outcomes.push(outcome);
      try {
        options.onItem?.(outcome);
      } catch {
        /* observers must not break the run */
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  outcomes.sort((a, b) => a.index - b.index);
  const succeeded = outcomes.filter((o) => o.ok).length;
  return { outcomes, succeeded, failed: outcomes.length - succeeded, incomplete: !exhausted };
}
