import { ChromaClient } from 'chromadb';
import { Document } from '@langchain/core/documents';
import type { Embeddings } from '@langchain/core/embeddings';
import { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import { HealthReport, errorMessage, healthReport } from '../../resilience/health.js';
import { RetryOptions, resilientCall } from '../../resilience/retry.js';
import { assertUserId, dropForeignResults } from './tenantGuard.js';
import type { EmbeddingModelMetadata, RAGDocumentMetadata, SearchResult, VectorStoreAdapter } from '../types.js';

/** Minimal surface of a Chroma collection / client that we use (also the unit-test seam). */
export interface ChromaCollectionLike {
  upsert(args: { ids: string[]; embeddings: number[][]; documents: string[]; metadatas: Record<string, any>[] }): Promise<unknown>;
  query(args: { queryEmbeddings: number[][]; nResults: number; where?: Record<string, any>; include?: string[] }): Promise<{
    ids: string[][];
    documents: (string | null)[][];
    metadatas: (Record<string, any> | null)[][];
    distances: (number | null)[][];
  }>;
  get(args: { ids?: string[]; where?: Record<string, any>; include?: string[]; limit?: number; offset?: number }): Promise<{ ids: string[]; metadatas?: (Record<string, any> | null)[] }>;
  delete(args: { ids?: string[]; where?: Record<string, any> }): Promise<unknown>;
}

export interface ChromaClientLike {
  heartbeat(): Promise<number>;
  getOrCreateCollection(args: Record<string, any>): Promise<ChromaCollectionLike>;
}

export interface ChromaAdapterOptions {
  /** Base collection name; the embedding model + dimensions are appended so incompatible vectors never mix. */
  collectionName: string;
  url?: string;
  embeddings: Embeddings;
  metadata: EmbeddingModelMetadata;
  client?: ChromaClientLike;
  retry?: RetryOptions;
  breaker?: CircuitBreaker;
  upsertBatchSize?: number;
}

const GET_PAGE = 1000;

export function chromaCollectionName(base: string, meta: EmbeddingModelMetadata): string {
  const slug = `${meta.provider}-${meta.modelId}-${meta.dimensions}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const name = `${base}__${slug}`.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
  return name.slice(0, 512);
}

function userWhere(userId: string) {
  return { userId: { $eq: userId } };
}
function sourceWhere(userId: string, sourceId: string) {
  return { $and: [{ userId: { $eq: userId } }, { sourceId: { $eq: sourceId } }] };
}

export class ChromaVectorStoreAdapter implements VectorStoreAdapter {
  readonly componentName = 'vectorstore:chroma';
  readonly collectionName: string;
  readonly breaker: CircuitBreaker;
  private readonly client: ChromaClientLike;
  private readonly embeddings: Embeddings;
  private readonly metadata: EmbeddingModelMetadata;
  private readonly retry: RetryOptions;
  private readonly batchSize: number;
  private collection?: ChromaCollectionLike;
  private pendingCollection?: Promise<ChromaCollectionLike>;

  constructor(options: ChromaAdapterOptions) {
    this.embeddings = options.embeddings;
    this.metadata = options.metadata;
    this.collectionName = chromaCollectionName(options.collectionName, options.metadata);
    this.retry = options.retry ?? { retries: 2, baseDelayMs: 400, maxDelayMs: 4_000 };
    this.batchSize = options.upsertBatchSize ?? 100;
    this.breaker = options.breaker ?? new CircuitBreaker({ name: this.componentName, failureThreshold: 3, cooldownMs: 10_000 });
    if (options.client) {
      this.client = options.client;
    } else {
      const u = new URL(options.url ?? process.env.CHROMA_URL ?? 'http://localhost:8000');
      this.client = new ChromaClient({
        host: u.hostname,
        port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
        ssl: u.protocol === 'https:',
      }) as unknown as ChromaClientLike;
    }
  }

  /** Lazily connects, so the host app can start (degraded) while Chroma is down and recover later. */
  private getCollection(): Promise<ChromaCollectionLike> {
    if (this.collection) return Promise.resolve(this.collection);
    this.pendingCollection ??= resilientCall(
      this.breaker,
      () =>
        this.client.getOrCreateCollection({
          name: this.collectionName,
          embeddingFunction: null,
          configuration: { hnsw: { space: 'cosine' } },
          metadata: { embeddingModel: this.metadata.modelId, dimensions: this.metadata.dimensions },
        }),
      this.retry,
    )
      .then((c) => (this.collection = c))
      .finally(() => {
        this.pendingCollection = undefined;
      });
    return this.pendingCollection;
  }

  private async call<T>(fn: (c: ChromaCollectionLike) => Promise<T>): Promise<T> {
    const collection = await this.getCollection();
    return resilientCall(this.breaker, () => fn(collection), this.retry);
  }

  /** Eagerly connect; resolves false instead of throwing when Chroma is unreachable. */
  async tryConnect(): Promise<boolean> {
    try {
      await this.getCollection();
      return true;
    } catch {
      return false;
    }
  }

  async addDocuments(documents: Document<RAGDocumentMetadata>[]): Promise<string[]> {
    if (documents.length === 0) return [];
    for (const d of documents) assertUserId(d.metadata?.userId);
    const vectors = await this.embeddings.embedDocuments(documents.map((d) => d.pageContent));
    const ids: string[] = [];
    for (let i = 0; i < documents.length; i += this.batchSize) {
      const batch = documents.slice(i, i + this.batchSize);
      const batchIds = batch.map((d) => d.metadata.contentHash);
      await this.call((c) =>
        c.upsert({
          ids: batchIds,
          embeddings: vectors.slice(i, i + this.batchSize),
          documents: batch.map((d) => d.pageContent),
          metadatas: batch.map((d) => stripUndefined(d.metadata)),
        }),
      );
      ids.push(...batchIds);
    }
    return ids;
  }

  async similaritySearch(query: string, k: number, filter: { userId: string }): Promise<SearchResult[]> {
    assertUserId(filter?.userId);
    if (k <= 0) return [];
    const queryVector = await this.embeddings.embedQuery(query);
    const res = await this.call((c) =>
      c.query({
        queryEmbeddings: [queryVector],
        nResults: k,
        where: userWhere(filter.userId),
        include: ['documents', 'metadatas', 'distances'],
      }),
    );
    const ids = res.ids?.[0] ?? [];
    const results: SearchResult[] = ids.map((id, i) => ({
      id,
      document: new Document<RAGDocumentMetadata>({
        pageContent: res.documents?.[0]?.[i] ?? '',
        metadata: (res.metadatas?.[0]?.[i] ?? {}) as RAGDocumentMetadata,
      }),
      score: 1 - (res.distances?.[0]?.[i] ?? 1),
    }));
    return dropForeignResults(results, filter.userId).safe.sort((a, b) => b.score - a.score);
  }

  private async idsMatching(where: Record<string, any>): Promise<string[]> {
    const all: string[] = [];
    for (let offset = 0; ; offset += GET_PAGE) {
      const page = await this.call((c) => c.get({ where, include: [], limit: GET_PAGE, offset }));
      all.push(...page.ids);
      if (page.ids.length < GET_PAGE) break;
    }
    return all;
  }

  private async deleteIds(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += GET_PAGE) {
      const chunk = ids.slice(i, i + GET_PAGE);
      await this.call((c) => c.delete({ ids: chunk }));
    }
  }

  async deleteBySourceId(sourceId: string, userId: string, options: { keepIds?: string[] } = {}): Promise<number> {
    assertUserId(userId);
    const keep = new Set(options.keepIds ?? []);
    const doomed = (await this.idsMatching(sourceWhere(userId, sourceId))).filter((id) => !keep.has(id));
    await this.deleteIds(doomed);
    return doomed.length;
  }

  async deleteByUserId(userId: string): Promise<number> {
    assertUserId(userId);
    const ids = await this.idsMatching(userWhere(userId));
    await this.deleteIds(ids);
    return ids.length;
  }

  async countBySourceId(sourceId: string, userId: string): Promise<number> {
    assertUserId(userId);
    return (await this.idsMatching(sourceWhere(userId, sourceId))).length;
  }

  async existingChunkIds(ids: string[], userId: string): Promise<Set<string>> {
    assertUserId(userId);
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += GET_PAGE) {
      const slice = ids.slice(i, i + GET_PAGE);
      const res = await this.call((c) => c.get({ ids: slice, where: userWhere(userId), include: [] }));
      for (const id of res.ids) found.add(id);
    }
    return found;
  }

  async findSourceByDocHash(docHash: string, userId: string, excludeSourceId?: string): Promise<string | undefined> {
    assertUserId(userId);
    const clauses: Record<string, any>[] = [{ userId: { $eq: userId } }, { docHash: { $eq: docHash } }];
    if (excludeSourceId) clauses.push({ sourceId: { $ne: excludeSourceId } });
    const res = await this.call((c) => c.get({ where: { $and: clauses }, include: ['metadatas'], limit: 1 }));
    const sourceId = res.metadatas?.[0]?.sourceId;
    return typeof sourceId === 'string' ? sourceId : undefined;
  }

  async getEmbeddingModelMetadata(): Promise<EmbeddingModelMetadata> {
    return this.metadata;
  }

  async checkHealth(): Promise<HealthReport> {
    try {
      await Promise.race([
        this.client.heartbeat(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat timed out')), 2_000).unref?.()),
      ]);
    } catch (err) {
      return healthReport('down', `Chroma unreachable: ${errorMessage(err)}`);
    }
    const breaker = await this.breaker.checkHealth();
    return breaker.status === 'up' ? healthReport('up', this.collectionName) : breaker;
  }
}

function stripUndefined(meta: Record<string, unknown>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
}
