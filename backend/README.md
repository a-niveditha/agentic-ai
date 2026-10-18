# @agentic-ai/backend

> Parent: [repository root](../README.md)

Express API over the `@agentic-ai/agent` library. See the root [README](../README.md) for the overview.

- `src/config/env.ts` — validated configuration (fails fast; no default JWT secret)
- `src/container.ts` — wires providers, stores, tools and services (the one place to swap implementations)
- `src/app.ts` — middleware stack (helmet, CORS allowlist, request ids, redacted logging, rate limits) and routes
- `src/routes/*` — auth · chat (SSE) · documents · rag · health
- `src/transports/wsServer.ts` — authenticated WebSocket chat
- `src/services/*` — storage adapters (Prisma/SQLite, in-memory), `ChatService`, `DocumentService`
- Every storage method takes the owning `userId` and enforces it inside the query; foreign ids look like missing ones (404).

Run: `bun run dev:backend` · typecheck: `bun run typecheck` · API reference: `/api/v1/docs`.

## Documentation map

Every folder has a README with its contracts, invariants and tests. Start at [src/README.md](src/README.md):

- [src/config](src/config/README.md): environment variables and OpenAPI
- [src/lib](src/lib/README.md): errors, tokens and stream tickets, logger, SSE
- [src/middleware](src/middleware/README.md): auth, validation, rate limits, error format
- [src/routes](src/routes/README.md): endpoints (full reference: [docs/api.md](../docs/api.md))
- [src/services](src/services/README.md): storage port, `ChatService`, `DocumentService`
- [src/transports](src/transports/README.md): WebSocket protocol
- [prisma](prisma/README.md): data model

Cross-package docs: [docs/README.md](../docs/README.md).

