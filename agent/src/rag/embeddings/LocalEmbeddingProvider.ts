import { HuggingFaceTransformersEmbeddings } from '@langchain/community/embeddings/huggingface_transformers';
import { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import { HealthReport } from '../../resilience/health.js';
import { RetryOptions, resilientCall } from '../../resilience/retry.js';
import { EmbeddingProvider } from './EmbeddingProvider.js';
import type { EmbeddingModelMetadata } from '../types.js';

export interface LocalEmbeddingConfig {
  model?: string;
  dimensions?: number;
  retry?: RetryOptions;
  breaker?: CircuitBreaker;
  /** Test seam. */
  client?: { embedDocuments(d: string[]): Promise<number[][]>; embedQuery(q: string): Promise<number[]> };
}

/** On-device embeddings (no API key, works offline once the model is cached). */
export class LocalEmbeddingProvider extends EmbeddingProvider {
  readonly componentName = 'embeddings:local';
  readonly metadata: EmbeddingModelMetadata;
  readonly breaker: CircuitBreaker;
  private readonly client: NonNullable<LocalEmbeddingConfig['client']>;
  private readonly retry: RetryOptions;

  constructor(config: LocalEmbeddingConfig = {}) {
    super({ maxRetries: 0 });
    const model = config.model ?? 'Xenova/all-MiniLM-L6-v2';
    this.metadata = { provider: 'local', modelId: model, dimensions: config.dimensions ?? 384 };
    this.retry = config.retry ?? { retries: 1, baseDelayMs: 500 };
    this.breaker = config.breaker ?? new CircuitBreaker({ name: this.componentName, failureThreshold: 3, cooldownMs: 10_000 });
    this.client = config.client ?? new HuggingFaceTransformersEmbeddings({ model });
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (documents.length === 0) return [];
    return resilientCall(this.breaker, () => this.client.embedDocuments(documents), this.retry);
  }

  async embedQuery(text: string): Promise<number[]> {
    return resilientCall(this.breaker, () => this.client.embedQuery(text), this.retry);
  }

  async checkHealth(): Promise<HealthReport> {
    return this.breaker.checkHealth();
  }
}
