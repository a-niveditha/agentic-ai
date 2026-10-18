import { Embeddings, EmbeddingsParams } from '@langchain/core/embeddings';
import type { HealthCheckable, HealthReport } from '../../resilience/health.js';
import type { EmbeddingModelMetadata } from '../types.js';

/**
 * Extension point for embedding vendors. It is a LangChain `Embeddings`, so it plugs into any LangChain
 * vector store, plus metadata (used to namespace vector collections) and a health check.
 */
export abstract class EmbeddingProvider extends Embeddings implements HealthCheckable {
  abstract readonly componentName: string;
  abstract readonly metadata: EmbeddingModelMetadata;
  abstract checkHealth(): Promise<HealthReport>;

  constructor(params: EmbeddingsParams = {}) {
    super(params);
  }
}
