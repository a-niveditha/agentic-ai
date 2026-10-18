# routes

> Parent: [backend/src](../README.md)

HTTP route factories. Each `createXRouter(deps: Dependencies)` receives the container and returns an Express `Router`; [app.ts](../app.ts) mounts them all under the version prefix `/api/v1` ([config/api.ts](../config/api.ts)); there are no unversioned routes. The complete request/response reference with examples is [docs/api.md](../../../docs/api.md); an OpenAPI version is served at `/api/v1/docs` ([config/swagger.ts](../config/swagger.ts)).

## Conventions every route follows

1. **Identity is `currentUserId(req)`**, from the verified token. Ids or user fields in bodies, queries or headers are ignored (validated schemas strip unknown keys).
2. Input is validated with zod (`validate`) before the handler runs; ids are UUIDs.
3. Ownership is enforced inside the service / storage query. A resource that belongs to someone else is indistinguishable from a missing one: **404**, never 403.
4. Failures are thrown as `AppError` and rendered by the central handler ([middleware](../middleware/README.md)).
5. Mutating and expensive routes are rate limited (per user when authenticated).

## Route map

| Mount | Method & path | Auth | Purpose |
|---|---|---|---|
| `/api` ([healthRoutes.ts](healthRoutes.ts)) | `GET /health` | none | Liveness |
| | `GET /ready` | none | Per-component status; 503 only when the database is down |
| `/api/v1/auth` ([authRoutes.ts](authRoutes.ts)) | `POST /signup`, `POST /login` | none (rate limited) | Create account / get access token |
| | `GET /me` | Bearer | Current user |
| | `POST /stream-ticket` | Bearer | Single-use ticket for SSE-GET and WebSocket |
| `/api/v1/chat` ([chatRoutes.ts](chatRoutes.ts)) | `GET/POST /sessions`, `PATCH/DELETE /sessions/:id` | Bearer | Session CRUD |
| | `GET /sessions/:id/messages` | Bearer | History with parsed metadata |
| | `POST /sessions/:id/messages` | Bearer | Send a message; reply streams as SSE |
| | `GET /sessions/:id/stream?ticket=&text=` | Ticket | EventSource-friendly variant |
| `/api/v1/documents` ([documentRoutes.ts](documentRoutes.ts)) | `GET /`, `GET /:id` | Bearer | List / get (poll for indexing status) |
| | `POST /` | Bearer | Multipart `file`, or JSON `{ text, title? }` / `{ url }` → **202**, indexed in the background |
| | `POST /:id/retry` | Bearer | Re-run indexing → **202** |
| | `DELETE /:id` | Bearer | Cancel any indexing, delete vectors first, then the row |
| `/api/v1/rag` ([ragRoutes.ts](ragRoutes.ts)) | `POST /query` | Bearer | Standalone RAG; JSON, or SSE with `Accept: text/event-stream` |

## Notable behaviours

- Chat turns: a session runs one turn at a time (409 `session_busy`). The user's message is persisted before the model is called. After the stream starts, failures are sent as an `error` event, not an HTTP status.
- Documents: validation, quota, URL fetching and duplicate checks happen in the request; indexing runs in the background. Success is **202** with the document in status `processing` and a `Location` header; the client polls `GET /documents/:id` until `ready` or `failed` (`errorMessage` explains a failure; `POST /:id/retry` re-runs it, also 202). Identical content is **409 `duplicate_document`** naming the existing document. A full indexing queue is **503 `queue_full`** with `Retry-After`. Delete refuses to drop the row if the vectors could not be removed.
- `/api/v1/rag/query` returns 503 when the knowledge base is `unavailable`; a `degraded` answer (model down) is 200 with the retrieved passages.

## Tests

[`__tests__/`](__tests__): `auth`, `chat`, `documents`, `ragHealthErrors` unit tests against the real app with in-memory fakes. End-to-end on real infrastructure: [tests/integration](../../../tests/integration/README.md).
