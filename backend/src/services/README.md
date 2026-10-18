# services

> Parent: [backend/src](../README.md)

Business logic and persistence. Routes and transports call these; they know nothing about HTTP.

## Interface contract: `AbstractStorageAdapter` ([AbstractStorageAdapter.ts](AbstractStorageAdapter.ts))

The persistence port (also a `HealthCheckable` with `componentName = 'database'`). **Every method that touches user data takes the owning `userId` and must enforce it inside the query itself**, so guessing an id cannot reach another user's row. A foreign id is indistinguishable from a missing one (`null` / `false`).

| Area | Methods |
|---|---|
| Users | `createUser(email, passwordHash, name)`, `findUserByEmail(email)` (includes `passwordHash`), `findUserById(id)` |
| Sessions | `createSession(userId, title?)`, `listSessions`, `getSession`, `renameSession`, `deleteSession` (cascades messages) |
| Messages | `saveMessage(userId, sessionId, sender, content, metadata?)` → `null` if the session is not the user's; `getMessages(userId, sessionId, { limit? })` oldest-first, last N, `null` if not owned |
| Documents | `createDocument` (throws `DuplicateContentError` for a repeated `contentHash`), `findDocumentByContentHash`, `updateDocument`, `getDocument`, `getDocumentContent` (internal, for retry), `listDocuments`, `countDocuments`, `deleteDocument` |

Entity shapes are in [types.ts](types.ts): `IUser`, `IChatSession`, `IChatMessage` (`sender: 'user' | 'agent'`, `metadata` is a JSON string holding `status`, `citations`, `toolCalls`, `error`), `IDocument` (`status: 'processing' | 'ready' | 'failed'`).

| Implementation | Use |
|---|---|
| [`PrismaStorageAdapter`](PrismaStorageAdapter.ts) | Production (SQLite via Prisma; schema in [prisma](../../prisma/README.md)). Connection failures surface as Prisma errors that the central error handler turns into 503 + `Retry-After`; `checkHealth()` reports `down`. |
| [`InMemoryStorageAdapter`](InMemoryStorageAdapter.ts) | Tests and demos. |

Both must pass the shared [`storageContract.ts`](__tests__/storageContract.ts) test suite; run it against any new adapter.

## `ChatService` ([chatService.ts](chatService.ts))

```ts
runChatTurn({ userId, sessionId, text, signal?, onEvent }): Promise<ChatAgentResult>
assertCanChat(userId, sessionId): Promise<void>   // 404 not owned, 409 session_busy
```

One turn: load the last N messages → **persist the user message first** (an outage never loses what they typed) → `prepareHistory` (summarise or trim) → run the agent with a context built from the verified user (`principalId = tenantId = userId`, configured scopes, per-turn budgets) → persist the assistant message with `status`, `citations`, `toolCalls`, `error` → auto-title new sessions from the first message → emit a final `done` that includes `sessionId`, `messageId`, `status`. Failed turns are stored but not replayed to the model as history. One concurrent turn per session. If saving the reply fails, an `error` event with code `persist_failed` is sent.

Both SSE routes and the WebSocket use this single entry point.

## `DocumentService` ([documentService.ts](documentService.ts))

Implements the agent's `DocumentSink` port. Lifecycle:

```
request:     validate → (fetch URL) → reject duplicate content → create row (`processing`, text + hash stored) → 202
background:  IngestionQueue → chunk, embed in batches, store → `ready`  |  retry with backoff → `failed` + safe errorMessage
```

Everything cheap and fixable by the user is rejected synchronously; the slow, outage-prone part runs in an in-process [`IngestionQueue`](../../../agent/src/rag/ingestion/queue/README.md) (`INGEST_CONCURRENCY`, `INGEST_MAX_QUEUED`, `INGEST_MAX_ATTEMPTS`). Documents of one user and source never index concurrently.

| Method | Contract |
|---|---|
| `uploadFile(userId, file)` | Returns the document as `processing`. Loader registry picks the loader; sanitised filename. Errors: 415 `file_unsupported`, 413 `file_too_large`, 422 `file_mismatch` / `file_empty` / `file_corrupt`, 409 `duplicate_document`, 503 `queue_full`. |
| `addText(userId, { title, text, … })` | Returns `processing`. 413 over the character limit, 422 empty, 409 duplicate. |
| `addUrl(userId, url)` | Scrapes through the SSRF-guarded scraper. Errors: 400 `url_blocked` / `url_invalid_url`, 415 `url_unsupported_content`, 504 `url_timeout`, 502 other fetch errors. |
| `retry(userId, id)` | Returns `processing` and re-indexes from the stored text. 409 `content_unavailable` if none, 409 `already_processing` if a job for it is queued or running. |
| `remove(userId, id)` | Cancels and waits for any indexing job of the document, deletes vectors, then the row. If the vector delete fails the row is kept and 503 returned, so success is never reported while vectors may remain. |
| `saveText(context, doc)` | `DocumentSink`: owner is `context.tenantId`, never model input. Unlike uploads it indexes **before returning** (the model reports the outcome and may search it next); a failure is a 503 `indexing_failed` carrying the failed document. |
| `whenIdle()` / `shutdown()` | Wait for / stop background indexing (graceful shutdown waits a few seconds, then stops; unfinished documents stay `processing` and can be retried). |
| `list` / `get` / `supportedExtensions()` | Owner-scoped. |

Quota: 403 `quota_exceeded` beyond `MAX_DOCS_PER_USER`.

**Duplicates.** The sha256 of the text is stored as `contentHash`, unique per user (a database constraint, so simultaneous identical uploads create exactly one document). A repeat is `409 duplicate_document` with `duplicateOf` and the existing `document` (which may still be `processing` or `failed`). Other users may hold identical content, and a 409 never reveals another user's document. Deleting a document frees its hash.

**Failure handling.** Retryable indexing failures are retried by the queue with backoff; a final failure marks the document `failed` with a user-safe `errorMessage` (never the raw provider error).

## Tests

[`__tests__/`](__tests__): `services.unit.test.ts`, `inMemoryStorage.unit.test.ts`, and `prismaStorage.int.test.ts` (real SQLite) share one storage contract suite.
