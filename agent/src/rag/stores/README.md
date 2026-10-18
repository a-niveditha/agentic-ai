# rag/stores

> Parent: [agent/src/rag](../README.md)

Tenant-isolated vector storage.

## Interface contract: `VectorStoreAdapter` ([../types.ts](../types.ts))

```ts
interface VectorStoreAdapter extends HealthCheckable {
  addDocuments(documents: Document<RAGDocumentMetadata>[]): Promise<string[]>;           // returns chunk ids
  similaritySearch(query: string, k: number, filter: { userId: string }): Promise<SearchResult[]>;
  deleteBySourceId(sourceId: string, userId: string, options?: { keepIds?: string[] }): Promise<number>;
  deleteByUserId(userId: string): Promise<number>;
  countBySourceId(sourceId: string, userId: string): Promise<number>;
  getEmbeddingModelMetadata(): Promise<EmbeddingModelMetadata>;
}
```

Invariants every implementation must keep:

1. **Tenant isolation.** Every read and delete is scoped by `userId` server-side; a missing or blank `userId` throws (`assertUserId`). Never return another tenant's chunk even if the backend misbehaves: `dropForeignResults` in [tenantGuard.ts](tenantGuard.ts) is the second line of defence.
2. Chunk ids are deterministic (`contentHash` = sha256 of user, source, index, text), so re-ingesting is an upsert.
3. Metadata values are primitives only (a Chroma constraint). `RAGDocumentMetadata` requires `userId`, `sourceId`, `contentHash`, `chunkIndex`.
4. `SearchResult.score` is cosine similarity, higher is better.
5. External calls go through `resilientCall`; `checkHealth()` reports `down` when the store is unreachable.

### Optional capabilities (used by [ingestion](../ingestion/README.md))

```ts
existingChunkIds?(ids: string[], userId: string): Promise<Set<string>>;                    // which chunk ids this tenant already has
findSourceByDocHash?(docHash: string, userId: string, excludeSourceId?: string): Promise<string | undefined>;
```

Both must be tenant-scoped. They let ingestion resume after a failure, skip unchanged chunks on re-index, and detect duplicate uploads. A store without them still works: everything is embedded and duplicates are allowed. Both shipped adapters implement them (Chroma through `get` with `ids` / `$and` / `$ne`).

## Implementations

| Class | Use |
|---|---|
| [`ChromaVectorStoreAdapter`](ChromaVectorStoreAdapter.ts) | Production. Collection name = `<base>__<provider>-<model>-<dims>` (`chromaCollectionName`); batched upserts; `tryConnect()` lets the host start without blocking on Chroma. |
| [`InMemoryVectorStoreAdapter`](InMemoryVectorStoreAdapter.ts) | Unit tests and demos. Same contract, cosine similarity in memory. |

Run the shared capability suite in [`__tests__/vectorStores.unit.test.ts`](__tests__/vectorStores.unit.test.ts) against any new adapter.

## Tests

[`__tests__/vectorStores.unit.test.ts`](__tests__/vectorStores.unit.test.ts) (both adapters), [`__tests__/chroma.int.test.ts`](__tests__/chroma.int.test.ts) (real Chroma + real Gemini embeddings). Isolation attacks: [tests/security/tenantIsolation.sec.test.ts](../../../../tests/security/tenantIsolation.sec.test.ts).
