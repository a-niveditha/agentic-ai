# rag/retrieval

> Parent: [agent/src/rag](../README.md)

Finding relevant chunks and answering from them, with untrusted-content fencing.

## Contracts

### `TenantRetriever` ([retriever.ts](retriever.ts))

LangChain `BaseRetriever` bound to one tenant.

```ts
new TenantRetriever({ store, userId, topK?, minScore?, maxTokens? })
retriever.search(query, override?): Promise<SearchResult[]>
```

- `userId` is bound at construction from trusted context and is never read from the query.
- `topK` is clamped to 1…`MAX_TOP_K` (10); `minScore` filters weak matches; `maxTokens` caps the returned text (≈ 4 characters per token, `applyBudget`).
- `_getRelevantDocuments()` (the LangChain interface) returns documents with `publicMetadata`: no `userId` or `contentHash`.
- `toCitation(result)` is what may leave the process: title, source, snippet, `sourceId`, `url`, plus `page` and `section` when the chunk has them.
- `publicMetadata` drops `userId`, `contentHash` and `docHash`.

### `fenceUntrusted(text, attrs)` and `UNTRUSTED_NOTICE` ([untrusted.ts](untrusted.ts))

Wraps retrieved, scraped or tool text in `<untrusted …>` blocks; `neutralizeFence` stops content from closing the fence early. Use it for **any** external text that goes into a prompt. `UNTRUSTED_NOTICE` is the system-prompt rule that tells the model to treat fenced text as data.

### `StandaloneRagChain` ([ragChain.ts](ragChain.ts))

Retrieve → fenced prompt → model, with no agent loop and no history.

```ts
new StandaloneRagChain({ store, modelProvider, retrieve?: RetrieveOptions })
chain.answer(question, userId, { signal?, retrieve? }): Promise<RagAnswer>
chain.stream(question, userId, onEvent: (e: RagEvent) => void, { signal?, retrieve? }): Promise<RagAnswer>

type RagStatus = 'completed' | 'degraded' | 'unavailable' | 'no_context' | 'interrupted';
interface RagAnswer { status: RagStatus; answer: string; citations: Citation[]; error?: string }
type RagEvent = start | citation | token | error | done      // payloads in ragChain.ts
```

Degradation instead of failure:

| Situation | Result |
|---|---|
| Vector store down | `unavailable`, friendly `error` event, no answer |
| Nothing relevant | `no_context` with `NO_CONTEXT_MESSAGE` |
| Model down | `degraded`: the retrieved passages and citations are returned instead of a generated answer |
| Aborted | `interrupted` |

## Tests

[`__tests__/ragChain.unit.test.ts`](__tests__/ragChain.unit.test.ts); retriever behaviour in [`../__tests__/chunkIngestRetrieve.unit.test.ts`](../__tests__/chunkIngestRetrieve.unit.test.ts); fencing in [tests/security/injection.sec.test.ts](../../../../tests/security/injection.sec.test.ts).
