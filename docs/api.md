# API reference

HTTP + Server-Sent Events + WebSocket API of [`backend/`](../backend/README.md). Source of truth is the code in [backend/src/routes](../backend/src/routes/README.md); an interactive OpenAPI view is served at `/api/v1/docs` (and the JSON at `/api/v1/docs-json`) when `ENABLE_DOCS` is on (default outside production).

- Base URL: `http://localhost:5000/api/v1` (`PORT`). The version is part of every path, including the docs (`/api/v1/docs`) and the WebSocket (`/api/v1/ws`); there are no unversioned routes (`/api/documents` is a 404). Paths below are shown in full.
- Content type: `application/json`, except document upload (`multipart/form-data`).
- Every response carries `x-request-id`; send your own (8–64 chars of `[A-Za-z0-9_-]`) to correlate logs.

## Conventions

### Authentication

| Credential | How to send | Where accepted |
|---|---|---|
| Access token (JWT, `typ: access`, 7 d) | `Authorization: Bearer <token>` | Every route except those marked *public* |
| Stream ticket (JWT, `typ: stream`, ~60 s, **single use**) | `?ticket=<ticket>` | `GET /api/v1/chat/sessions/:id/stream` and the WebSocket handshake only |

Tokens are never accepted from cookies or from the query string on other routes. A ticket is rejected as a Bearer token and an access token is rejected as a ticket. Get a ticket from `POST /api/v1/auth/stream-ticket`.

### Errors

Every non-2xx JSON response has this shape:

```json
{ "error": "Human readable message", "code": "machine_code", "requestId": "3f1c…", "issues": [ { "path": "email", "message": "Invalid email" } ] }
```

`issues` appears only for `validation_error`. Stack traces and internal details are never included.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `validation_error`, `invalid_json`, `upload_error`, `bad_request`, `url_blocked`, `url_invalid_url` | Bad input |
| 401 | `unauthorized`, `invalid_token`, `invalid_ticket`, `invalid_credentials` | Missing / bad / expired / reused credential |
| 403 | `quota_exceeded`, `forbidden` | Over the document quota; invalid execution context |
| 404 | `not_found` | Missing **or not yours** (indistinguishable by design) |
| 409 | `email_taken`, `session_busy`, `content_unavailable`, `already_processing`, `duplicate_document` | Conflict |
| 413 | `payload_too_large`, `file_too_large` | Body, upload or document text too large |
| 415 | `file_unsupported`, `url_unsupported_content` | Unsupported type |
| 422 | `file_empty`, `file_corrupt`, `file_mismatch` | File readable but unusable or not what its extension claims |
| 429 | `rate_limited` | Too many requests (`RateLimit-*` headers) |
| 502 / 504 | `url_http_error`, `url_network`, `url_timeout`, … | Fetching a URL failed |
| 503 | `service_unavailable`, `queue_full` | Dependency down or indexing queue full; `Retry-After` header set |
| 500 | `internal_error` | Unexpected (generic message) |

### Rate limits (per minute, per IP for auth and per user otherwise)

`POST /auth/signup|login`: `RATE_LIMIT_AUTH_PER_MIN` (20) · chat messages and `/rag/query`: `RATE_LIMIT_CHAT_PER_MIN` (30) · document writes: `RATE_LIMIT_DOCS_PER_MIN` (30).

### Streaming events

Chat and RAG replies are streamed as events with the shape `{ "type": "...", "payload": {...}, "timestamp": 1730000000000 }`. Over SSE each is one `data: <json>\n\n` frame (comment lines starting `:` are keep-alives; ignore them). Over WebSocket each is one JSON text frame.

| `type` | `payload` | Notes |
|---|---|---|
| `start` | `{ message, executionId }` | First event |
| `token` | `{ token }` | Append to the reply |
| `tool_start` | `{ id, tool, input }` | The agent is calling a tool |
| `tool_end` | `{ id, tool, success, output }` | `output` is truncated to 4 000 chars |
| `citation` | `{ citations: [{ title, source, content, sourceId?, url?, page?, section? }] }` | Sources used; `sourceId` is the document id; `page` (PDF, 1-based) and `section` (heading path of Markdown / HTML) locate the passage when known |
| `error` | `{ message, code }` | Friendly message; the turn still ends with `done` |
| `done` | `{ fullResponse, citationsCount, status, sessionId, messageId }` | Always last. `status`: `completed`, `interrupted`, `limit_reached`, `error` |

Errors that occur **before** streaming starts (auth, validation, unknown session, busy session, rate limit) are normal JSON errors with an HTTP status. Once the stream has started, failures arrive as an `error` event.

---

## Health (public)

### `GET /api/v1/health`
Liveness; never touches dependencies.
`200 { "status": "ok", "uptimeSeconds": 12, "timestamp": "…" }`

### `GET /api/v1/ready`
Per-component readiness. Optional dependencies degrade gracefully, so only a database outage returns 503.
`200 | 503 { "status": "up"|"degraded"|"down", "components": { "database": "up", "llm:gemini": "up", "embeddings:gemini": "up", "vectorstore:chroma": "up", "search:duckduckgo": "up", "scraper:http": "up", "tools": "up" }, "timestamp": "…" }`
Only statuses are exposed, never details. Component names depend on the configured implementations.

---

## Auth

### `POST /api/v1/auth/signup` *(public, rate limited)*
Body: `{ "email": string (valid, ≤ 254, stored lower-case), "password": string (8–128), "name": string (1–100) }`
`201 { "user": { "id", "email", "name", "createdAt" }, "token": "<access token>" }`
Errors: 400 `validation_error`, 409 `email_taken`, 429.

### `POST /api/v1/auth/login` *(public, rate limited)*
Body: `{ "email", "password" }`
`200 { "user": { … }, "token": "…" }`
Errors: 401 `invalid_credentials` (identical for unknown email and wrong password, with comparable timing), 429.

### `GET /api/v1/auth/me`
`200 { "user": { "id", "email", "name", "createdAt" } }`

### `POST /api/v1/auth/stream-ticket`
Body (optional): `{ "sessionId": "<uuid>" }` binds the ticket to one session.
`200 { "ticket": "<jwt>", "expiresInSeconds": 60 }`
Use it once, within its lifetime.

---

## Chat

A session belongs to one user. A session handles one turn at a time.

### `GET /api/v1/chat/sessions`
`200 { "sessions": [ { "id", "title", "createdAt", "updatedAt" } ] }` (most recent first)

### `POST /api/v1/chat/sessions`
Body (optional): `{ "title": string (1–100) }` → `201 { "session": { … } }` (title defaults to "New Conversation" and is replaced by the first message).

### `PATCH /api/v1/chat/sessions/:id`
Body: `{ "title": string (1–100) }` → `200 { "success": true }`. 404 if not yours.

### `DELETE /api/v1/chat/sessions/:id`
`200 { "success": true }`; messages are deleted with it. 404 if not yours.

### `GET /api/v1/chat/sessions/:id/messages`
`200 { "messages": [ { "id", "sessionId", "sender": "user"|"agent", "content", "createdAt", "metadata": null | { "status", "citations": […], "toolCalls": [ { "name", "input", "ok" } ], "error"? } } ] }` oldest first. 404 if not yours.

### `POST /api/v1/chat/sessions/:id/messages` — send a message, stream the reply
Body: `{ "text": string (1–4000, `MAX_MESSAGE_CHARS`) }`
`200 text/event-stream` with the [events](#streaming-events) above.
Errors before the stream: 400, 401, 404, 409 `session_busy`, 429.
Your message is stored before the model is called; the reply is stored when the turn ends (with `status`, citations and tool calls). Closing the connection aborts the turn.

```bash
curl -N -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"What does my handbook say about expenses?"}' \
  http://localhost:5000/api/v1/chat/sessions/$SESSION/messages
```

### `GET /api/v1/chat/sessions/:id/stream?ticket=<ticket>&text=<message>` — EventSource variant
For clients that cannot set headers. `text` is 1–2000 chars. Same event stream as above; authentication is the single-use ticket (bound to the session if issued with `sessionId`). Errors: 401 `invalid_ticket` (missing, expired, reused, wrong session).

### WebSocket `ws://host/api/v1/ws?ticket=<ticket>`
Full protocol (messages, error codes, handshake rejections): [transports README](../backend/src/transports/README.md).

---

## Documents (knowledge base)

Documents are private to the user. Supported file types: see `supportedExtensions` in the list response (txt, log, md, markdown, pdf, docx, html, htm, csv, tsv, json).

**Adding a document is asynchronous.** The request validates the input and answers `202 Accepted` with the document in status `processing`; chunking and embedding continue in the background. Poll `GET /documents/:id` (the `Location` header) until `status` is `ready` or `failed`. Retryable outages (rate limits, a vector-store restart) are retried automatically with backoff before a document is marked `failed`.

Status lifecycle: `processing` → `ready` | `failed`. A `failed` document keeps its text and can be re-run with `/retry`.

Document object: `{ "id", "filename", "mimeType", "sourceUrl": string|null, "status", "errorMessage": string|null, "chunksCount", "createdAt", "updatedAt" }`. `chunksCount` is 0 until `ready`. `errorMessage` is a short, user-safe reason when `failed`. Extracted text and the content hash are never returned.

### `GET /api/v1/documents`
`200 { "documents": [ … ], "supportedExtensions": ["txt", …] }` (newest first)

### `GET /api/v1/documents/:id`
`200 { "document": { … } }`. 404 if not yours. This is the status endpoint to poll.

### `POST /api/v1/documents` — add a document
One of:

1. `multipart/form-data` with a single `file` field (max `MAX_UPLOAD_MB`, default 10). The extension decides the loader, and the bytes must match it.
2. JSON `{ "text": string (≤ 2 000 000), "title"?: string (≤ 200) }`
3. JSON `{ "url": "https://…" }`: the server fetches the page now (public addresses only, SSRF-guarded), so a blocked or unreachable URL is rejected in the request; indexing then continues in the background.

`202 { "document": { … "status": "processing" } }` with `Location: /api/v1/documents/<id>`.

Errors (all returned immediately, nothing is created):

| Status | `code` | Meaning |
|---|---|---|
| 400 | `validation_error`, `upload_error`, `url_blocked`, `url_invalid_url` | Bad input, malformed upload, forbidden URL |
| 403 | `quota_exceeded` | Document limit reached |
| 409 | `duplicate_document` | Identical content is already in your knowledge base. Body: `{ error, code, requestId, duplicateOf: "<document id>", document: { … } }`. The existing document may still be `processing` or may be `failed` (use its `/retry`). Duplicates are detected per user by the content of the extracted text, regardless of filename or URL. |
| 413 | `file_too_large` | Upload or text too large |
| 415 | `file_unsupported`, `url_unsupported_content` | Unsupported type |
| 422 | `file_empty`, `file_corrupt`, `file_mismatch` | Unusable file, or bytes do not match the extension |
| 502 / 504 | `url_http_error`, `url_network`, `url_timeout`, … | Fetching the URL failed |
| 503 | `queue_full` | Too many documents are being processed; `Retry-After` set. Nothing was created. |

```bash
curl -i -H "Authorization: Bearer $TOKEN" -F file=@handbook.pdf http://localhost:5000/api/v1/documents
# 202 Accepted, Location: /api/v1/documents/3f2b…   then:
curl -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/v1/documents/3f2b…   # until "status": "ready"
```

### `POST /api/v1/documents/:id/retry`
Re-runs chunking and embedding from the stored text. `202 { "document": { … "status": "processing" } }`. Errors: 404 not yours; 409 `content_unavailable` (the text is no longer stored); 409 `already_processing` (a job for this document is queued or running).

### `DELETE /api/v1/documents/:id`
Cancels any indexing of the document, deletes its vectors, then the row. `200 { "success": true }`. 503 (row kept) if the vector store could not be reached; retry later. The content hash is freed, so the same content can be added again.

---

## Standalone RAG

### `POST /api/v1/rag/query`
Answers one question from the user's knowledge base: no tools, no chat history.
Body: `{ "question": string (1–4000), "topK"?: integer (1–10) }`

JSON response (default):
`200 { "status": "completed"|"degraded"|"no_context"|"interrupted", "answer": string, "citations": [ … ], "error"?: string }`
`503` with `"status": "unavailable"` when the knowledge base is unreachable.

- `no_context`: nothing relevant was found (`answer` says so).
- `degraded`: the model was unavailable, so `answer` contains the retrieved passages instead of a generated answer.

Send `Accept: text/event-stream` to receive events instead (`start`, `citation`, `token`, `error`, `done` with `{ fullResponse, citationsCount, status }`).
