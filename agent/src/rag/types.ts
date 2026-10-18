import type { Document } from '@langchain/core/documents';
import type { HealthCheckable } from '../resilience/health.js';

export interface EmbeddingModelMetadata {
  provider: string;
  modelId: string;
  dimensions: number;
}

/** Metadata stored with every chunk. Values must be primitives (Chroma constraint). */
export interface RAGDocumentMetadata extends Record<string, string | number | boolean | undefined> {
  /** Tenant isolation key: always filtered on at query time. */
  userId: string;
  /** The logical source (e.g. the DB document id); chunks are replaced / deleted per source. */
  sourceId: string;
  /** Deterministic chunk id: hash(userId, sourceId, chunkIndex, text). */
  contentHash: string;
  chunkIndex: number;
  title?: string;
  sourceUrl?: string;
  mimeType?: string;
  /** 1-based page of the source (paged formats such as PDF). */
  page?: number;
  /** Heading path of the section the chunk belongs to, e.g. "Setup > Install". */
  section?: string;
  /** First / last data row covered by the chunk (tabular formats). */
  rowStart?: number;
  rowEnd?: number;
  /** sha256 of the whole indexed document text; identifies identical documents of one tenant. */
  docHash?: string;
}

export interface SearchResult {
  id: string;
  document: Document<RAGDocumentMetadata>;
  /** Cosine similarity, higher is better. */
  score: number;
}

export interface IngestionResult {
  success: boolean;
  /** Chunks that now represent the source (embedded now + already stored). */
  chunksIndexed: number;
  documentIds: string[];
  /** Stale chunks of a previous version of the same source that were removed. */
  chunksRemoved: number;
  /** Chunks sent to the embedding model in this run. */
  chunksEmbedded: number;
  /** Chunks that were already stored unchanged and were not embedded again. */
  chunksSkipped: number;
  /** sha256 of the indexed text. */
  documentHash: string;
  /** Name of the chunking strategy that was used. */
  chunker: string;
  /** Set when an identical document (same tenant) already exists under another source id. */
  duplicateOf?: string;
}

export interface Citation {
  title: string;
  source: string;
  content: string;
  sourceId?: string;
  url?: string;
  page?: number;
  section?: string;
}

/**
 * Extension point for vector databases. EVERY read and delete is scoped by `userId`; implementations must
 * enforce it server-side and must not return other tenants' chunks even if the backend misbehaves.
 */
export interface VectorStoreAdapter extends HealthCheckable {
  addDocuments(documents: Document<RAGDocumentMetadata>[]): Promise<string[]>;
  similaritySearch(query: string, k: number, filter: { userId: string }): Promise<SearchResult[]>;
  /** Deletes a source's chunks; `keepIds` are retained (used to swap in a new version). Returns count removed. */
  deleteBySourceId(sourceId: string, userId: string, options?: { keepIds?: string[] }): Promise<number>;
  /** Removes everything a user owns (account deletion). Returns count removed. */
  deleteByUserId(userId: string): Promise<number>;
  countBySourceId(sourceId: string, userId: string): Promise<number>;
  getEmbeddingModelMetadata(): Promise<EmbeddingModelMetadata>;

  /**
   * Optional capability: which of these chunk ids does this tenant already have stored? Lets ingestion resume
   * after a partial failure and skip unchanged chunks when a document is re-indexed.
   */
  existingChunkIds?(ids: string[], userId: string): Promise<Set<string>>;
  /**
   * Optional capability: the source id of another document of this tenant with the same `docHash`
   * (ignoring `excludeSourceId`), used to detect duplicate uploads.
   */
  findSourceByDocHash?(docHash: string, userId: string, excludeSourceId?: string): Promise<string | undefined>;
}
