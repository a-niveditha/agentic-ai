import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import { HealthReport, healthReport } from '../../resilience/health.js';
import { RetryOptions, resilientCall } from '../../resilience/retry.js';
import { EmbeddingProvider } from './EmbeddingProvider.js';
import type { EmbeddingModelMetadata } from '../types.js';

export interface GeminiEmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
  retry?: RetryOptions;
  breaker?: CircuitBreaker;
  /** Test seam. */
  client?: Pick<GoogleGenerativeAIEmbeddings, 'embedDocuments' | 'embedQuery'>;
}

export class GeminiEmbeddingProvider extends EmbeddingProvider {
  readonly componentName = 'embeddings:gemini';
  readonly metadata: EmbeddingModelMetadata;
  readonly breaker: CircuitBreaker;
  private readonly client: Pick<GoogleGenerativeAIEmbeddings, 'embedDocuments' | 'embedQuery'>;
  private readonly retry: RetryOptions;
  private readonly hasKey: boolean;

  constructor(config: GeminiEmbeddingConfig = {}) {
    super({ maxRetries: 0 });
    const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
    const model = config.model ?? 'gemini-embedding-001';
    this.hasKey = Boolean(apiKey) || Boolean(config.client);
    this.metadata = { provider: 'google', modelId: model, dimensions: config.dimensions ?? 3072 };
    this.retry = config.retry ?? { retries: 3, baseDelayMs: 1_000, maxDelayMs: 15_000 };
    this.breaker = config.breaker ?? new CircuitBreaker({ name: this.componentName, failureThreshold: 4, cooldownMs: 20_000 });
    this.client =
      config.client ??
      new GoogleGenerativeAIEmbeddings({
        apiKey: apiKey || 'missing',
        model,
        maxRetries: 0,
        ...(config.dimensions ? { outputDimensionality: config.dimensions } : {}),
      });
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (documents.length === 0) return [];
    this.requireKey();
    return resilientCall(this.breaker, () => this.client.embedDocuments(documents), this.retry);
  }

  async embedQuery(text: string): Promise<number[]> {
    this.requireKey();
    return resilientCall(this.breaker, () => this.client.embedQuery(text), this.retry);
  }

  async checkHealth(): Promise<HealthReport> {
    if (!this.hasKey) return healthReport('down', 'GEMINI_API_KEY is not configured');
    return this.breaker.checkHealth();
  }

  private requireKey(): void {
    if (!this.hasKey) throw Object.assign(new Error('Gemini API key is not configured (API key missing).'), { status: 401 });
  }
}
