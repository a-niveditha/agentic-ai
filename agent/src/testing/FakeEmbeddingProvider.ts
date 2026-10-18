import { EmbeddingProvider } from '../rag/embeddings/EmbeddingProvider.js';
import type { EmbeddingModelMetadata } from '../rag/types.js';
import { HealthReport, healthReport } from '../resilience/health.js';

/** Deterministic bag-of-words embeddings (hash trick). Good enough for similarity tests; needs no network. */
export class FakeEmbeddingProvider extends EmbeddingProvider {
  readonly componentName = 'embeddings:fake';
  readonly metadata: EmbeddingModelMetadata;
  failNext = 0;
  calls = 0;

  constructor(private readonly dims = 128) {
    super({});
    this.metadata = { provider: 'fake', modelId: `hash-${dims}`, dimensions: dims };
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
      v[Math.abs(h) % this.dims]! += 1;
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / norm);
  }

  private maybeFail() {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw Object.assign(new Error('embedding backend unavailable (503)'), { status: 503 });
    }
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    this.maybeFail();
    return documents.map((d) => this.vector(d));
  }

  async embedQuery(text: string): Promise<number[]> {
    this.maybeFail();
    return this.vector(text);
  }

  async checkHealth(): Promise<HealthReport> {
    return healthReport('up');
  }
}
