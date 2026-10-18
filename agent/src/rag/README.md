# rag

> Parent: [agent/src](../README.md)

Retrieval-augmented generation. Each stage is its own folder with its own interface contract.

```
bytes ─loaders─▶ text ─ingestion─▶ chunks ─embeddings─▶ stores   (userId filter on every call)
                                                           │
question ─retrieval (TenantRetriever)─▶ SearchResult[] ─fence─▶ prompt ─model─▶ answer + citations
```

## Sub-folders

| Folder | Contract | Doc |
|---|---|---|
| [loaders/](loaders/) | `DocumentLoader`: file bytes → text | [README](loaders/README.md) |
| [ingestion/](ingestion/) | `ingestDocument` pipeline (structure-aware chunking, batched and resumable embedding, duplicates, pluggable stages), `ingestMany`, background `IngestionQueue` | [README](ingestion/README.md) |
| [ingestion/chunkers/](ingestion/chunkers/) | `Chunker` strategies: paged, markdown, tabular, recursive | [README](ingestion/chunkers/README.md) |
| [ingestion/queue/](ingestion/queue/) | `IngestionQueue` background jobs | [README](ingestion/queue/README.md) |
| [embeddings/](embeddings/) | `EmbeddingProvider`: Gemini, local, factory | [README](embeddings/README.md) |
| [stores/](stores/) | `VectorStoreAdapter`: Chroma, in-memory, tenant guard | [README](stores/README.md) |
| [retrieval/](retrieval/) | `TenantRetriever`, `StandaloneRagChain`, `fenceUntrusted` | [README](retrieval/README.md) |

Dependencies point one way: `retrieval` and `ingestion` → `stores` → `embeddings`; `loaders` stands alone and `types.ts` is shared by all.

## Shared types ([types.ts](types.ts))

| Type | Meaning |
|---|---|
| `RAGDocumentMetadata` | Stored with every chunk: `userId` (tenant key, always filtered on), `sourceId` (logical source, e.g. the DB document id), `contentHash`, `chunkIndex`, `docHash`, optional `title`, `sourceUrl`, `mimeType`, and location (`page`, `section`, `rowStart`, `rowEnd`). Values are primitives. |
| `SearchResult` | `{ id, document, score }`, score is cosine similarity (higher is better). |
| `IngestionResult` | `{ success, chunksIndexed, documentIds, chunksRemoved, chunksEmbedded, chunksSkipped, documentHash, chunker, duplicateOf? }`. |
| `Citation` | `{ title, source, content, sourceId?, url?, page?, section? }`: what may be shown to clients. |
| `EmbeddingModelMetadata` | `{ provider, modelId, dimensions }`. |
| `VectorStoreAdapter` | The storage port, documented in [stores](stores/README.md). |

## Importing

Everything is re-exported from [index.ts](index.ts) and, from there, from the package entry (`@agentic-ai/agent`). Inside the package import from the specific folder.

## Tests

Each folder keeps its own `__tests__/`. Cross-cutting chunk → ingest → retrieve tests and the shared in-memory store helper live in [`__tests__/`](__tests__) (`chunkIngestRetrieve.unit.test.ts`, `helpers.ts`).
