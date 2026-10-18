# rag/embeddings

> Parent: [agent/src/rag](../README.md)

Turns text into vectors. The vector store, retriever and ingestion only depend on `EmbeddingProvider`.

## Interface contract: `EmbeddingProvider` ([EmbeddingProvider.ts](EmbeddingProvider.ts))

Abstract class: a LangChain `Embeddings` plus `HealthCheckable` and identity.

```ts
abstract class EmbeddingProvider extends Embeddings implements HealthCheckable {
  abstract readonly componentName: string;
  abstract readonly metadata: { provider: string; modelId: string; dimensions: number };
  abstract checkHealth(): Promise<HealthReport>;
  // from Embeddings: embedDocuments(string[]), embedQuery(string)
}
```

Implementer obligations:

1. `metadata` must be accurate: it namespaces the vector collection, so changing the model never mixes incompatible vectors.
2. Route external calls through `resilientCall` (retry + circuit breaker, see [resilience](../../resilience/README.md)); report `down` from `checkHealth()` when the backend is unreachable or the key is missing.
3. Never fall back silently to a *different* model: that would corrupt the collection.

## Implementations

| Class | Notes |
|---|---|
| [`GeminiEmbeddingProvider`](GeminiEmbeddingProvider.ts) | `gemini-embedding-001`, 3072 dims. Key from `GEMINI_API_KEY` / `GOOGLE_API_KEY`. |
| [`LocalEmbeddingProvider`](LocalEmbeddingProvider.ts) | On-device `Xenova/all-MiniLM-L6-v2`, 384 dims; no key, works offline once the model is cached. |
| [`createEmbeddingProvider({ provider, apiKey?, model? })`](embeddingFactory.ts) | Picks one; `provider` defaults to `EMBEDDING_PROVIDER`, then `gemini`. Unknown value throws. |

Both accept `retry`, `breaker` and a `client` test seam. A deterministic fake for tests is in [testing](../../testing/README.md).

## Tests

[`__tests__/embeddings.unit.test.ts`](__tests__/embeddings.unit.test.ts)
