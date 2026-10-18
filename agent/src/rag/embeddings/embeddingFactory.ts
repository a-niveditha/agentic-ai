import { EmbeddingProvider } from './EmbeddingProvider.js';
import { GeminiEmbeddingProvider } from './GeminiEmbeddingProvider.js';
import { LocalEmbeddingProvider } from './LocalEmbeddingProvider.js';

export interface EmbeddingFactoryConfig {
  provider?: 'gemini' | 'local';
  apiKey?: string;
  model?: string;
}

export function createEmbeddingProvider(config: EmbeddingFactoryConfig = {}): EmbeddingProvider {
  const provider = config.provider ?? (process.env.EMBEDDING_PROVIDER as 'gemini' | 'local' | undefined) ?? 'gemini';
  switch (provider) {
    case 'gemini':
      return new GeminiEmbeddingProvider({ apiKey: config.apiKey, model: config.model });
    case 'local':
      return new LocalEmbeddingProvider({ model: config.model });
    default:
      throw new Error(`Unknown embedding provider '${provider}'. Use 'gemini' or 'local'.`);
  }
}
