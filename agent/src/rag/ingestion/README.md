# rag/ingestion

> Parent: [agent/src/rag](../README.md) · Sub-folders: [chunkers](chunkers/README.md), [queue](queue/README.md)

Turns text into indexed, searchable chunks for one tenant: transform → chunk → enrich → embed in batches → store → clean up. Everything here is independent of HTTP and of any database; the host decides when and where it runs (inline, in the [queue](queue/README.md), or in bulk with `ingestMany`).

```
text ─TextTransformer*─▶ Chunker (picked by file type) ─ChunkEnricher*─▶ batches ─embed─▶ store ─▶ remove stale chunks
        (PII redaction…)     paged · markdown · tabular · recursive      (skip chunks already stored)
```

## `ingestDocument(text, store, options)` ([ingestion.ts](ingestion.ts))

Returns `IngestionResult`: `{ success, chunksIndexed, documentIds, chunksRemoved, chunksEmbedded, chunksSkipped, documentHash, chunker, duplicateOf? }`.

| Option | Default | Meaning |
|---|---|---|
| `userId`, `sourceId` | required | Tenant and logical source (the backend uses the database document id). A blank `userId` or missing `sourceId` throws. |
| `title`, `sourceUrl`, `mimeType` | none | Stored with each chunk. `mimeType` and the extension of `title` select the chunker. |
| `chunkSize`, `chunkOverlap` | 1000 / 150 | Passed to the chunker. |
| `maxChunks` | none | Cost / quota cap. |
| `chunker` | structure-aware registry | A `Chunker`, or a `ChunkerRegistry`, to override detection. |
| `transformers`, `enrichers` | none | [Pluggable stages](#pluggable-stages). |
| `embedBatchSize` | 32 | Chunks per embedding request. |
| `minBatchIntervalMs` | 0 | Minimum gap between embedding requests, to stay under provider rate limits. |
| `forceReembed` | false | Embed everything even if identical chunks are stored. |
| `onDuplicate` | `allow` | `skip` returns `duplicateOf` without indexing; `error` throws `DuplicateDocumentError`. |
| `signal` | none | Cancellation. |
| `onProgress` | none | `{ stage: 'preparing'\|'chunking'\|'embedding'\|'cleanup'\|'done', done, total }`. A throwing observer is ignored. |

### Guarantees

1. **Never loses the previous version.** New chunks are upserted first; stale chunks are removed only afterwards, and only if the run completed. A failure or cancellation midway leaves the old version searchable.
2. **Idempotent and resumable.** Chunk ids are deterministic (`chunkContentHash`: tenant, source, position, text, and location when present). Chunks already stored unchanged are skipped (`chunksSkipped`) when the store supports `existingChunkIds`, so a retry after a failure pays only for what is missing, and re-indexing an unchanged or lightly edited document is nearly free. Moving a chunk to another page or section changes its id, so it is re-embedded with the right location.
3. **Rate-limit friendly.** Batches are paced and each batch is a separate request, so one 429 retries one batch rather than the whole document.
4. **Tenant-scoped.** Duplicate detection and the existing-chunk lookup are filtered by `userId`; another user's identical document is never a duplicate.
5. **Failures propagate.** Embedding or store errors are thrown unchanged for the host to classify (the backend marks the document `failed` and offers `/retry`); cancellation throws an `AbortError`.
6. **Optional store capabilities degrade gracefully.** Without `existingChunkIds` / `findSourceByDocHash` everything is embedded and duplicates are allowed; a failing lookup is ignored.

### What gets stored with each chunk

`RAGDocumentMetadata` ([../types.ts](../types.ts)) plus structural location when the format has one: `page` (PDF), `section` (heading path for Markdown / HTML), `rowStart` / `rowEnd` (CSV), and `docHash` (sha256 of the indexed text, never shown to clients). Page and section reach citations (`Citation.page`, `Citation.section`) and the model's source labels.

## Pluggable stages ([stages.ts](stages.ts))

```ts
interface TextTransformer { name: string; transform(text, context): string | Promise<string> }   // before chunking
interface ChunkEnricher   { name: string; enrich(chunks, context): TextChunk[] | Promise<TextChunk[]> } // after chunking
```

Run in the order given. Throwing fails the ingestion before anything is stored. Shipped: `PiiRedactor` (opt-in; emails, Luhn-valid card numbers, US SSNs, phone numbers; a pattern-based safeguard, not a compliance guarantee) and `MinLengthFilter` (drops near-empty chunks).

## Bulk and re-index: `ingestMany(items, store, options)` ([ingestMany.ts](ingestMany.ts))

Ingests many documents with bounded `concurrency` (default 2); `items` may be an async iterable so documents can be streamed from a database. One failing document never blocks the rest: you get `{ outcomes, succeeded, failed, incomplete }` with a per-document result or `{ message, retryable }`. Options: `signal`, `onItem`, `defaults`, `stopOnError`.

**Re-indexing after changing the embedding model:** point the new store at the same documents and run `ingestMany` over their stored text. The new collection starts empty, so everything is embedded; running it again after a partial failure embeds only what is missing.

## Files

| File | Purpose |
|---|---|
| [ingestion.ts](ingestion.ts) | `ingestDocument`, `chunkContentHash`, `hashDocumentText`, `DuplicateDocumentError` |
| [ingestMany.ts](ingestMany.ts) | Bulk / re-index runner |
| [stages.ts](stages.ts) | `TextTransformer`, `ChunkEnricher`, `PiiRedactor`, `MinLengthFilter` |
| [chunker.ts](chunker.ts) | `chunkTextToDocuments` (recursive splitting primitive) |
| [chunkers/](chunkers/README.md) | Chunking strategies per document type |
| [queue/](queue/README.md) | Background job runner |

## Tests

[`__tests__/`](__tests__): `pipeline` (strategies, batching, pacing, resume, cancellation, duplicates, stages, PII), `chunkers`, `ingestMany`, `queue` unit tests; real Chroma + Gemini in [../stores/__tests__/chroma.int.test.ts](../stores/__tests__/chroma.int.test.ts). Chunk → ingest → retrieve basics: [../__tests__/chunkIngestRetrieve.unit.test.ts](../__tests__/chunkIngestRetrieve.unit.test.ts).
