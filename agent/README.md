# @agentic-ai/agent

> Parent: [repository root](../README.md)

The reusable core (no HTTP framework). Import everything from `@agentic-ai/agent`.

| Folder | What |
|---|---|
| `context.ts` | `AgentContext` (zod): the trusted identity + budgets a run executes as |
| `models/` | `ChatModelProvider` interface, `GeminiChatModelProvider` |
| `rag/` | embeddings, vector stores (Chroma, in-memory), loaders, chunking, ingestion, `TenantRetriever`, `StandaloneRagChain` |
| `tools/` | `BaseAgentTool`, `ToolRegistry`, scope policy, `ToolBudget`, built-in tools |
| `web/` | `SearchProvider` (DuckDuckGo, fallback chain), `Scraper` (`HttpScraper` + `SsrfGuard`) |
| `mcp/` | `McpToolSource` — tools from external MCP servers, with background reconnect |
| `agent/` | `ChatAgent` (LangChain `createAgent`), streaming events, conversation memory |
| `resilience/` | health checks, error classification, retry, circuit breaker |
| `testing/` | `ScriptedChatModel`, `FakeEmbeddingProvider` — deterministic fakes for your own tests |

Minimal use:

```ts
const registry = new ToolRegistry().register(new CalculatorTool()).register(new KnowledgeBaseSearchTool(store));
const agent = new ChatAgent({ modelProvider: new GeminiChatModelProvider(), registry });
const result = await agent.run({
  messages: [{ role: 'user', content: 'What is 12 * 34?' }],
  context: { principalId: 'u1', tenantId: 'u1', scopes: ['kb:read'], executionId: crypto.randomUUID(), budget: { maxToolCalls: 4, maxModelCalls: 6 } },
  onEvent: (e) => console.log(e.type, e.payload),
});
```

## Documentation map

Every folder has a README with its interface contracts, invariants and tests. Start at [src/README.md](src/README.md):

- [src/agent](src/agent/README.md): `ChatAgent`, stream events, memory
- [src/models](src/models/README.md): `ChatModelProvider`
- [src/rag](src/rag/README.md): pipeline overview, with [loaders](src/rag/loaders/README.md), [ingestion](src/rag/ingestion/README.md), [embeddings](src/rag/embeddings/README.md), [stores](src/rag/stores/README.md) and [retrieval](src/rag/retrieval/README.md)
- [src/tools](src/tools/README.md) and [src/tools/builtins](src/tools/builtins/README.md): tool base class, registry, budget, built-in tools
- [src/web](src/web/README.md): search, scraper, SSRF guard
- [src/mcp](src/mcp/README.md): MCP client
- [src/resilience](src/resilience/README.md): health, errors, retry, circuit breaker
- [src/testing](src/testing/README.md): fakes for your own tests

Cross-package docs: [docs/README.md](../docs/README.md).
