# agent/src

> Parent: [agent](../README.md)

Source of the `@agentic-ai/agent` library. Everything public is re-exported from [index.ts](index.ts), which is the package entry point.

## Sub-folders

| Folder | Extension point / contract | Doc |
|---|---|---|
| [agent/](agent/) | `ChatAgent`, stream events, conversation memory | [README](agent/README.md) |
| [models/](models/) | `ChatModelProvider` (LLM vendors) | [README](models/README.md) |
| [rag/](rag/) | RAG pipeline overview and shared types | [README](rag/README.md) |
| [rag/loaders/](rag/loaders/) | `DocumentLoader` (file formats) | [README](rag/loaders/README.md) |
| [rag/ingestion/](rag/ingestion/) | Chunking and `ingestDocument` | [README](rag/ingestion/README.md) |
| [rag/embeddings/](rag/embeddings/) | `EmbeddingProvider` | [README](rag/embeddings/README.md) |
| [rag/stores/](rag/stores/) | `VectorStoreAdapter`, tenant guard | [README](rag/stores/README.md) |
| [rag/retrieval/](rag/retrieval/) | `TenantRetriever`, `StandaloneRagChain`, untrusted fencing | [README](rag/retrieval/README.md) |
| [tools/](tools/) | `BaseAgentTool`, `RegisteredTool`, `ToolRegistry`, `ToolBudget` | [README](tools/README.md) |
| [tools/builtins/](tools/builtins/) | Calculator, knowledge-base search, web search / scrape, save-to-KB | [README](tools/builtins/README.md) |
| [web/](web/) | `SearchProvider`, `Scraper`, `SsrfGuard` | [README](web/README.md) |
| [mcp/](mcp/) | MCP client: `McpToolSource`, config | [README](mcp/README.md) |
| [resilience/](resilience/) | `HealthCheckable`, error classification, retry, circuit breaker | [README](resilience/README.md) |
| [testing/](testing/) | Scripted model and fake embeddings for tests | [README](testing/README.md) |

Dependencies point downwards: `agent` → `tools` / `rag` / `models` → `web` / `resilience`. Nothing in this package knows about HTTP, Express, Prisma or any database; the host application supplies those through ports (`DocumentSink`, `VectorStoreAdapter`, `ChatModelProvider`, `SearchProvider`, `Scraper`).

## `AgentContext` ([context.ts](context.ts))

The trusted identity a run executes as. The host builds it from **verified credentials** (never from request bodies or model output); `parseAgentContext` validates it and returns a deeply frozen copy.

```ts
{
  principalId: string;     // the authenticated user
  tenantId: string;        // data-isolation key (the backend uses the user id)
  scopes: string[];        // what the user may do: 'kb:read', 'kb:write', 'web', 'mcp', ...
  executionId: string;     // correlates logs and events of one run
  budget: { maxToolCalls: number; maxModelCalls: number /* default 8 */; maxTokens?: number };
}
```

Contract: `parseAgentContext(input)` throws `InvalidAgentContextError` when malformed; `isAgentContext(x)` is the non-throwing check used by the tool policy (an invalid context is authorised for nothing). Tools read identity only from here, never from model-supplied arguments.

## Other files

| File | Purpose |
|---|---|
| [context.ts](context.ts) | `AgentContext` schema and helpers |
| [index.ts](index.ts) | Public API barrel (also re-exports `Document` and `BaseCallbackHandler` from LangChain) |
| [pdf-parse.d.ts](pdf-parse.d.ts) | Type shim for `pdf-parse` |
| [`__tests__/context.unit.test.ts`](__tests__/context.unit.test.ts) | Context tests |
