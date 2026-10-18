# tools/builtins

> Parent: [agent/src/tools](../README.md)

The five tools shipped with the template. All extend [`BaseAgentTool`](../BaseAgentTool.ts), so they get validation, scope checks, cancellation and structured error results for free. Their contracts below are what the model sees and what the host must provide.

| Tool (`name`) | Required scopes | Input (zod) | Constructor dependency | Returns |
|---|---|---|---|---|
| [`calculator`](CalculatorTool.ts) | none | `expression` (1–`MAX_LENGTH` chars) | none | `{ expression, result }`; a hand-written parser supports `+ - * / % ^` and parentheses, never `eval` |
| [`knowledge_base_search`](KnowledgeBaseSearchTool.ts) | `kb:read` | `query` (≤ 500), `topK?` (1–10, default 4) | `VectorStoreAdapter`, `{ minScore? }` | Fenced passages with citations; `{ matches, results[] }` |
| [`web_search`](WebSearchTool.ts) | `web` | `query` (≤ 300), `maxResults?` (1–8, default 5) | `SearchProvider` | Fenced list of title / URL / snippet |
| [`web_scrape`](WebScrapeTool.ts) | `web` | `url` (http/https, ≤ 2000) | `Scraper`, `{ maxChars? }` (default 12 000) | Fenced Markdown of the page plus a citation |
| [`save_to_knowledge_base`](SaveToKnowledgeBaseTool.ts) | `web` **and** `kb:write` | `url`, `title?` (≤ 200) | `Scraper`, `DocumentSink`, `{ maxChars? }` (default 80 000) | `{ documentId, chunksIndexed, url, truncated }` |

## Rules these tools follow (copy them in your own tools)

- **Identity comes from the trusted `AgentContext` only.** `knowledge_base_search` builds its `TenantRetriever` from `ctx.tenantId`; no schema has a user field, so a model that "names" another user changes nothing.
- **External text is fenced** with `fenceUntrusted()` before it reaches the model.
- **Failures become `ToolUserError`** with a message safe for the model and `retryable` set; the model is told the capability is unavailable and can answer with a caveat.
- Aborts propagate (the tool rethrows abort errors so the run ends as `interrupted`).

## Port: `DocumentSink` ([SaveToKnowledgeBaseTool.ts](SaveToKnowledgeBaseTool.ts))

The host implements persistence for `save_to_knowledge_base`:

```ts
interface DocumentSink {
  saveText(
    context: AgentContext,
    doc: { title: string; text: string; sourceUrl?: string; mimeType?: string },
  ): Promise<{ documentId: string; chunksIndexed: number }>;
}
```

The backend's [`DocumentService`](../../../../backend/src/services/README.md) implements it (DB row, ingestion, quota). Implementations must take the owner from `context.principalId`, enforce quotas, and throw `ToolUserError` for user-presentable failures.

## Tests

[`../__tests__/builtins.unit.test.ts`](../__tests__/builtins.unit.test.ts). Agent-level behaviour with real Gemini: [tests/e2e](../../../../tests/e2e/README.md).
