# Agentic AI template

A reusable starting point for a **RAG + tool-using chatbot**: a typed TypeScript library (`agent/`) and an Express
backend (`backend/`) with auth, per-user knowledge bases, streaming chat (SSE and WebSocket) and graceful degradation
everywhere. Everything external (LLM, embeddings, vector DB, search, scraping, tools) sits behind an interface so you
can swap or extend it.

```
agent/     library: models, RAG, loaders, tools, MCP, web, chat agent, resilience     (no HTTP framework)
backend/   Express API: auth, chat sessions, documents, RAG query, SSE + WebSocket, Prisma/SQLite
frontend/  Next.js UI for chat, knowledge-base management, standalone RAG, and service status
tests/     helpers, fixtures, end-to-end and security suites
```

## Quick start

```bash
bun install
cp .env.example backend/.env           # set JWT_SECRET (openssl rand -base64 48) and GEMINI_API_KEY
bunx prisma db push --schema backend/prisma/schema.prisma
bun run chroma                         # disk-backed Chroma on :8000  (or: docker compose --env-file backend/.env up -d chromadb)
bun run dev:backend                    # http://localhost:5000  ·  docs: /api/v1/docs  ·  readiness: /api/v1/ready
```

No Gemini key? The server still starts: chat reports the model as unavailable, and `/api/v1/ready` shows it `down`.
No Chroma? Same: the knowledge base degrades, everything else keeps working. Use `VECTOR_STORE=memory` for a
volatile store.

## Frontend and Docker

Run the UI with `bun run dev:frontend` or both apps with `bun run dev`. To run the complete production stack in
Docker, copy `.env.example` to the root `.env`, set `JWT_SECRET` (for example, `openssl rand -base64 48`), then run:

```bash
docker compose up --build
```

This starts the Next.js frontend at http://localhost:3000, the API at http://localhost:5000, and Chroma at
http://localhost:8000. SQLite is persisted in the `backend_data` Docker volume and Chroma data in `data/chroma`.
Set `GEMINI_API_KEY` in `.env` to enable model and embedding calls. The browser API origin can be changed with
`NEXT_PUBLIC_API_BASE_URL` before building; `CORS_ORIGINS` must include the frontend's browser origin. See
[frontend/README.md](frontend/README.md) for individual service and Docker details.

## How a chat turn works

```
POST /api/v1/chat/sessions/:id/messages  {text}
  -> auth (Bearer JWT) -> load history (Prisma) -> save user message
  -> ChatAgent (LangChain createAgent) with the tools THIS user may use
       tools:  knowledge_base_search · web_search · web_scrape · save_to_knowledge_base · calculator · MCP tools
  -> stream events (start · token · tool_start · tool_end · citation · error · done) -> save reply + citations
```

Streaming options: `POST …/messages` (SSE, `Authorization` header), `GET …/stream?ticket=` (EventSource), or
WebSocket `/api/v1/ws?ticket=` with `{type:"chat", sessionId, text}` / `{type:"cancel"}`. Browsers cannot send headers on
EventSource/WebSocket, so `POST /api/v1/auth/stream-ticket` mints a **single-use ~60s ticket**; it is accepted only on those
endpoints and never as a general credential.

Stand-alone RAG without the agent loop: `POST /api/v1/rag/query {question}` (JSON, or SSE with `Accept: text/event-stream`).

## Extending it

Every extension point is an interface plus a default implementation. Implement it, then register it in
`backend/src/container.ts`.

| To add… | Implement | Notes |
|---|---|---|
| a **tool** | extend `BaseAgentTool` (zod `schema`, `run()`, `authPolicy.requiredScopes`) | identity comes from the trusted context only; failures become structured tool results |
| an **LLM** | `ChatModelProvider` | own your retries + circuit breaker (see `GeminiChatModelProvider`) |
| **embeddings** | extend `EmbeddingProvider` | the collection name embeds model + dimensions, so models never mix |
| a **vector DB** | `VectorStoreAdapter` | every method is scoped by `userId`; never return foreign tenants' chunks |
| a **file type** | extend `BaseDocumentLoader`, `LoaderRegistry.register()` | built in: txt, md, pdf, docx, html, csv, json |
| **web search** | `SearchProvider` (+ `FallbackSearchProvider` to chain) | DuckDuckGo is the default but throttles anonymous scrapers; chain a keyed provider behind it |
| **MCP servers** | `mcp.config.json` (see `mcp.config.example.json`) | tools need the `mcp` scope; a dead server never blocks startup |

Tools are authorized per request: `ToolRegistry.toolsFor(context)` returns only tools whose `requiredScopes` ⊆ the
caller's scopes. `DEFAULT_USER_SCOPES` decides what a normal user gets.

## Reliability model

Every component implements `checkHealth()`; `/api/v1/ready` reports each as `up | degraded | down` (details are not
exposed). External calls go through `resilientCall` (retry with backoff/jitter, honoring Retry-After) and a
`CircuitBreaker` so a dead service is not hammered. What happens when things fail:

| Fails | Behavior |
|---|---|
| Gemini chat (429, outage, bad key) | friendly `error` event; the user's message is still saved; RAG falls back to returning the retrieved passages |
| Gemini embeddings / Chroma | uploads are accepted (202) and indexing is retried automatically with backoff; if it still fails the document ends as `failed` with a safe reason and can be re-run with `POST /api/v1/documents/:id/retry`; chat continues without the KB |
| DuckDuckGo / scraper | the tool reports "unavailable"/the reason; the model carries on |
| MCP server | its tools disappear and it reconnects in the background |
| Database | 503 + Retry-After; `/api/v1/ready` → 503; liveness `/api/v1/health` stays 200 |
| Client disconnect / `cancel` | the model call and running tools are aborted; the partial reply is saved as `interrupted` |
| Tool budget / model-call limit | the model is told to answer with what it has; a runaway loop ends as `limit_reached` |

## Security model

Per-user data isolation is enforced at three layers (SQL queries filter by owner; the vector store requires and
re-checks `userId`; tools take identity from a trusted context, never from model arguments). Passwords are bcrypt
hashes; JWTs are HS256 with issuer + type checks and **no default secret**; URLs fetched by tools pass an SSRF guard
(public addresses only, re-validated on every redirect, connection pinned to the validated IP); uploads are
type-sniffed, size-limited and zip-bomb-checked; retrieved/scraped text is fenced as untrusted data in prompts.
See `docs/security-audit.md` for the test-backed audit.

## Tests

```bash
bun run typecheck
bun run test:unit          # fast, offline, fakes only (coverage report)
bun run test:integration   # real Gemini + disk Chroma + SQLite + stdio MCP + live web
bun run test:e2e           # full user journey on real infrastructure
bun run test:security      # cross-tenant, auth, SSRF, injection, hardening
```

Live suites read `backend/.env` and pace Gemini calls to the free-tier rate limit; they use `GEMINI_TEST_MODEL`
(default `gemini-3.5-flash-lite`) so they don't consume your main model's daily quota. Chroma for tests is started on
a free port under `data/chroma-test/` and wiped each run.

## Not included (yet)

Background ingestion queue (uploads are indexed in the request), a RAG quality evaluation harness, CI, and a
Postgres/pgvector option. Single-use stream tickets are tracked in memory: use a shared store
(`TicketStore`) when running more than one instance.

## Documentation

Every folder has a `README.md` with its interface contracts, linked parent-to-child. Start at [docs/README.md](docs/README.md) (index and documentation tree), then [agent/src/README.md](agent/src/README.md), [backend/src/README.md](backend/src/README.md) and [tests/README.md](tests/README.md). The HTTP/SSE/WebSocket reference is [docs/api.md](docs/api.md) and the security write-up is [docs/security-audit.md](docs/security-audit.md).

