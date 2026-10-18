# backend/src

> Parent: [backend](../README.md)

Source of the Express API. It is a thin HTTP/WebSocket layer over [`@agentic-ai/agent`](../../agent/README.md): it authenticates, validates, persists, and hands trusted identity to the agent.

## Sub-folders

| Folder | Role | Doc |
|---|---|---|
| [config/](config/) | Validated environment, OpenAPI | [README](config/README.md) |
| [lib/](lib/) | `AppError`, `TokenService` (access tokens and stream tickets), logger, SSE helper | [README](lib/README.md) |
| [middleware/](middleware/) | Auth, validation, rate limits, error handling | [README](middleware/README.md) |
| [routes/](routes/) | HTTP endpoints | [README](routes/README.md) |
| [services/](services/) | Storage port + adapters, `ChatService`, `DocumentService` | [README](services/README.md) |
| [transports/](transports/) | WebSocket chat | [README](transports/README.md) |
| [`../prisma/`](../prisma/) | Database schema | [README](../prisma/README.md) |

## Top-level files

| File | Contract |
|---|---|
| [container.ts](container.ts) | `buildDependencies(config, overrides?) → Dependencies`: the **one place that wires implementations** (storage, model, embeddings, vector store, search, scraper, loaders, MCP, tool registry, agent, services). `DependencyOverrides` is the test seam; any piece can be swapped (fake LLM, in-memory store). `Dependencies.healthComponents` is what `/api/v1/ready` reports on. Optional dependencies never throw during construction. |
| [app.ts](app.ts) | `createApp(deps) → Express`. Order: request-id + redacted pino-http → helmet → CORS allowlist → JSON body (3 MB) → docs (if enabled) → the `/api/v1` router (health, auth, chat, documents, rag) → 404 → error handler. `x-powered-by` is off; `TRUST_PROXY` controls the client IP. |
| [index.ts](index.ts) | Process entry: load config, build dependencies, connect Chroma and MCP **without blocking startup**, mount the app and WebSocket on one HTTP server, graceful shutdown on SIGINT/SIGTERM (10 s force exit). |

## Request flow

```
request ─▶ request id/log ─▶ helmet ─▶ CORS ─▶ body parser ─▶ rate limit ─▶ requireAuth ─▶ validate
        ─▶ route ─▶ service (ownership in the query) ─▶ agent / vector store ─▶ response or SSE stream
```

## Extending

- New route: add a `createXRouter(deps)` in [routes](routes/README.md), mount it in `app.ts`, add the zod schema, take identity from `currentUserId(req)`, and update [docs/api.md](../../docs/api.md) and `config/swagger.ts`.
- New dependency or implementation: add it to `Dependencies` and `buildDependencies`, with an override entry for tests.
