import { Document } from '@langchain/core/documents';
import type { Embeddings } from '@langchain/core/embeddings';
import { HealthReport, healthReport } from '../../resilience/health.js';
import { assertUserId, dropForeignResults } from './tenantGuard.js';
import type { EmbeddingModelMetadata, RAGDocumentMetadata, SearchResult, VectorStoreAdapter } from '../types.js';

export interface InMemoryAdapterOptions {
  embeddings: Embeddings;
  metadata: EmbeddingModelMetadata;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Process-local store: ideal for unit tests and demos. Same tenant guarantees as the Chroma adapter. */
export class InMemoryVectorStoreAdapter implements VectorStoreAdapter {
  readonly componentName = 'vectorstore:memory';
  private docs = new Map<string, { doc: Document<RAGDocumentMetadata>; embedding: number[] }>();
  private readonly metadata: EmbeddingModelMetadata;
  private readonly embeddings: Embeddings;

  constructor(options: InMemoryAdapterOptions) {
    this.metadata = options.metadata;
    this.embeddings = options.embeddings;
  }

  async addDocuments(documents: Document<RAGDocumentMetadata>[]): Promise<string[]> {
    if (documents.length === 0) return [];
    for (const d of documents) assertUserId(d.metadata?.userId);
    const vectors = await this.embeddings.embedDocuments(documents.map((d) => d.pageContent));
    return documents.map((doc, i) => {
      const id = doc.metadata.contentHash;
      this.docs.set(id, { doc, embedding: vectors[i]! });
      return id;
    });
  }

  async similaritySearch(query: string, k: number, filter: { userId: string }): Promise<SearchResult[]> {
    assertUserId(filter?.userId);
    const q = await this.embeddings.embedQuery(query);
    const scored: SearchResult[] = [...this.docs.entries()]
      .filter(([, v]) => v.doc.metadata.userId === filter.userId)
      .map(([id, v]) => ({ id, document: v.doc, score: cosineSimilarity(q, v.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
    return dropForeignResults(scored, filter.userId).safe;
  }

  async deleteBySourceId(sourceId: string, userId: string, options: { keepIds?: string[] } = {}): Promise<number> {
    assertUserId(userId);
    const keep = new Set(options.keepIds ?? []);
    let removed = 0;
    for (const [id, v] of this.docs) {
      if (v.doc.metadata.userId === userId && v.doc.metadata.sourceId === sourceId && !keep.has(id)) {
        this.docs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async deleteByUserId(userId: string): Promise<number> {
    assertUserId(userId);
    let removed = 0;
    for (const [id, v] of this.docs) {
      if (v.doc.metadata.userId === userId) {
        this.docs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  async countBySourceId(sourceId: string, userId: string): Promise<number> {
    assertUserId(userId);
    return [...this.docs.values()].filter((v) => v.doc.metadata.userId === userId && v.doc.metadata.sourceId === sourceId).length;
  }

  async existingChunkIds(ids: string[], userId: string): Promise<Set<string>> {
    assertUserId(userId);
    return new Set(ids.filter((id) => this.docs.get(id)?.doc.metadata.userId === userId));
  }

  async findSourceByDocHash(docHash: string, userId: string, excludeSourceId?: string): Promise<string | undefined> {
    assertUserId(userId);
    for (const v of this.docs.values()) {
      const m = v.doc.metadata;
      if (m.userId === userId && m.docHash === docHash && m.sourceId !== excludeSourceId) return m.sourceId;
    }
    return undefined;
  }

  async getEmbeddingModelMetadata(): Promise<EmbeddingModelMetadata> {
    return this.metadata;
  }

  async checkHealth(): Promise<HealthReport> {
    return healthReport('up', `${this.docs.size} chunks in memory`);
  }
}
