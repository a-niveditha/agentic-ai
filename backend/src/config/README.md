# config

> Parent: [backend/src](../README.md)

Validated runtime configuration and the OpenAPI document.

## Contract: `loadConfig(source = process.env): AppConfig` ([env.ts](env.ts))

- Parses the environment with zod and **fails fast**: an invalid configuration throws `ConfigError` listing every problem (the process then exits).
- `JWT_SECRET` is required (≥ 16 chars) and has no default. In production a publicly known example secret (`KNOWN_WEAK_JWT_SECRETS`) or `CORS_ORIGINS=*` is refused; elsewhere it only adds a warning.
- Derived fields on `AppConfig`: `geminiApiKey` (from `GEMINI_API_KEY` or `GOOGLE_API_KEY`), `corsOrigins[]`, `defaultScopes[]`, `docsEnabled` (explicit `ENABLE_DOCS`, otherwise on outside production), `warnings[]` (logged at startup, e.g. "no Gemini key: degraded mode").
- A missing Gemini key is **not** an error: the server starts and reports degraded.

### Variables

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` | `5000` | HTTP and WebSocket port |
| `DATABASE_URL` | `file:./dev.db` | Prisma / SQLite |
| `JWT_SECRET` | **required** | HS256 signing secret |
| `ACCESS_TOKEN_TTL` | `7d` | Access-token lifetime |
| `STREAM_TICKET_TTL_SECONDS` | `60` | 5–600 |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowlist (also checked on WebSocket `Origin`) |
| `TRUST_PROXY` | `0` | Hops of `X-Forwarded-For` to trust (rate limiting uses the client IP) |
| `ENABLE_DOCS` | on unless production | Serve `/api/v1/docs` and `/api/v1/docs-json` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | none | Model and embeddings credentials |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Chat model id |
| `GEMINI_MAX_RETRIES` | `2` | LangChain retries per request |
| `EMBEDDING_PROVIDER` | `gemini` | `gemini` or `local` |
| `VECTOR_STORE` | `chroma` | `chroma` or `memory` |
| `CHROMA_URL` / `CHROMA_COLLECTION` | `http://localhost:8000` / `agentic_ai_kb` | Chroma server and base collection name |
| `MCP_CONFIG_PATH` | none | Path to the MCP servers JSON |
| `DEFAULT_USER_SCOPES` | `kb:read,kb:write,web` | Scopes granted to every user (`mcp` is opt-in) |
| `MAX_UPLOAD_MB` | `10` | Upload size cap |
| `MAX_DOCS_PER_USER` | `200` | Document quota |
| `MAX_MESSAGE_CHARS` | `4000` | Chat message length |
| `INGEST_CONCURRENCY` / `INGEST_MAX_QUEUED` | `2` / `500` | Documents indexed at once / waiting before uploads get `503 queue_full` |
| `INGEST_MAX_ATTEMPTS` / `INGEST_RETRY_BASE_MS` | `3` / `2000` | Runs per document and first backoff delay for retryable indexing failures |
| `EMBED_BATCH_SIZE` / `EMBED_BATCH_INTERVAL_MS` | `32` / `0` | Chunks per embedding request / minimum gap between requests (raise the gap on tight provider quotas) |
| `MAX_TOOL_CALLS_PER_TURN` / `MAX_MODEL_CALLS_PER_TURN` | `6` / `8` | Per-turn agent budgets |
| `RATE_LIMIT_AUTH_PER_MIN` / `_CHAT_PER_MIN` / `_DOCS_PER_MIN` | `20` / `30` / `30` | Per-minute limits |
| `SSE_HEARTBEAT_MS` | `10000` | SSE keep-alive / liveness probe interval |
| `LOG_LEVEL` | `info` | pino level (`silent` for tests) |

The repository's [.env.example](../../../.env.example) mirrors this table.

## API version ([api.ts](api.ts))

`API_BASE` (`/api/v1`) is the single prefix for every route, the docs and the WebSocket. Changing the version means changing this constant (and keeping the old routers mounted if you need both).

## OpenAPI ([swagger.ts](swagger.ts))

`setupSwagger(app)` serves Swagger UI at `/api/v1/docs` and the raw spec at `/api/v1/docs-json`. The hand-written spec must be kept in sync with the routes; the full written reference is [docs/api.md](../../../docs/api.md).

## Tests

[`__tests__/env.unit.test.ts`](__tests__/env.unit.test.ts). Production refusals are also asserted in [tests/security/hardening.sec.test.ts](../../../tests/security/hardening.sec.test.ts).
