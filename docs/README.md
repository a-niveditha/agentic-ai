# Documentation index

> Parent: [repository root](../README.md)

Start here to find the contract of any part of the system. Every source folder has its own `README.md` describing its purpose, **interface contracts** (types, invariants, error behaviour), extension steps and tests; each README links to its parent and to its children, so you can navigate from the root down to any file or back up.

## Cross-cutting documents

| Document | What it covers |
|---|---|
| [../README.md](../README.md) | Overview, quick start, how a chat turn works, extension guide, reliability and security model |
| [api.md](api.md) | HTTP, SSE and WebSocket API reference: auth, errors, rate limits, event format, every endpoint |
| [security-audit.md](security-audit.md) | Threat model, findings, fixes, dependency audit, residual risks |

## Documentation tree

```
README.md  (repository)
├── agent/README.md ─ package overview
│   └── agent/src/README.md ─ AgentContext + module map
│       ├── agent/      ChatAgent, stream events, memory
│       ├── models/     ChatModelProvider (LLM vendors)
│       ├── rag/        pipeline overview, shared types
│       │   ├── loaders/     DocumentLoader (file formats)
│       │   ├── ingestion/   ingestDocument pipeline, ingestMany, stages
│       │   │   ├── chunkers/  paged, markdown, tabular, recursive
│       │   │   └── queue/     IngestionQueue (background jobs)
│       │   ├── embeddings/  EmbeddingProvider
│       │   ├── stores/      VectorStoreAdapter, tenant guard
│       │   └── retrieval/   TenantRetriever, StandaloneRagChain, untrusted fencing
│       ├── tools/      BaseAgentTool, ToolRegistry, ToolBudget
│       │   └── builtins/  calculator, knowledge-base search, web search/scrape, save-to-KB
│       ├── web/        SearchProvider, Scraper, SsrfGuard
│       ├── mcp/        MCP client (McpToolSource)
│       ├── resilience/ HealthCheckable, errors, retry, circuit breaker
│       └── testing/    ScriptedChatModel, FakeEmbeddingProvider
├── backend/README.md ─ package overview
│   ├── backend/src/README.md ─ container, app, entry point
│   │   ├── config/      environment variables, OpenAPI
│   │   ├── lib/         errors, tokens and tickets, logger, SSE
│   │   ├── middleware/  auth, validation, rate limits, error format
│   │   ├── routes/      endpoints
│   │   ├── services/    storage port, ChatService, DocumentService
│   │   └── transports/  WebSocket protocol
│   └── backend/prisma/README.md ─ data model
├── tests/README.md ─ test layers and how to run them
│   ├── setup/  helpers/  fixtures/  integration/  e2e/  security/
└── docs/  (this folder)
```

## Interface contracts at a glance

| Extension point | Contract | Default implementation | Doc |
|---|---|---|---|
| LLM vendor | `ChatModelProvider` | `GeminiChatModelProvider` | [agent/src/models](../agent/src/models/README.md) |
| Embeddings | `EmbeddingProvider` | Gemini, local (on-device) | [agent/src/rag/embeddings](../agent/src/rag/embeddings/README.md) |
| Vector database | `VectorStoreAdapter` (mandatory `userId` filter) | Chroma, in-memory | [agent/src/rag/stores](../agent/src/rag/stores/README.md) |
| File format | `DocumentLoader` / `BaseDocumentLoader` | txt, md, pdf, docx, html, csv, json | [agent/src/rag/loaders](../agent/src/rag/loaders/README.md) |
| Tool | `BaseAgentTool` / `RegisteredTool` | 5 built-in tools | [agent/src/tools](../agent/src/tools/README.md) |
| Dynamic tool set | `ToolSource` | `McpToolSource` | [agent/src/mcp](../agent/src/mcp/README.md) |
| Web search | `SearchProvider` | DuckDuckGo, fallback chain | [agent/src/web](../agent/src/web/README.md) |
| Page fetching | `Scraper`, `UrlGuard` | `HttpScraper`, `SsrfGuard` | [agent/src/web](../agent/src/web/README.md) |
| Saving to the knowledge base | `DocumentSink` | backend `DocumentService` | [agent/src/tools/builtins](../agent/src/tools/builtins/README.md) |
| Health reporting | `HealthCheckable` | every component | [agent/src/resilience](../agent/src/resilience/README.md) |
| Persistence | `AbstractStorageAdapter` | Prisma/SQLite, in-memory | [backend/src/services](../backend/src/services/README.md) |
| Single-use ticket store | `TicketStore` | in-memory | [backend/src/lib](../backend/src/lib/README.md) |
| Wiring / test seams | `Dependencies`, `DependencyOverrides` | `buildDependencies` | [backend/src](../backend/src/README.md) |

## Conventions for this documentation

- A folder README states the **contract first** (what callers may rely on), then files, then tests.
- When you change a contract, update the README of that folder in the same change; when you add a folder, add a README and link it from the parent.
- `__tests__/` folders are documented by the README of the folder that contains them.
