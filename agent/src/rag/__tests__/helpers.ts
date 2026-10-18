import { Document } from '@langchain/core/documents';
import { FakeEmbeddingProvider } from '../../testing/FakeEmbeddingProvider.js';
import { InMemoryVectorStoreAdapter } from '../stores/InMemoryVectorStoreAdapter.js';
import { chunkContentHash } from '../ingestion/ingestion.js';
import type { RAGDocumentMetadata } from '../types.js';

export function makeStore() {
  const embeddings = new FakeEmbeddingProvider();
  const store = new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata });
  return { embeddings, store };
}

export function doc(text: string, userId: string, sourceId: string, idx = 0, extra: Partial<RAGDocumentMetadata> = {}) {
  return new Document<RAGDocumentMetadata>({
    pageContent: text,
    metadata: { userId, sourceId, chunkIndex: idx, contentHash: chunkContentHash(text, userId, sourceId, idx), ...extra },
  });
}
