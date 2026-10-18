# middleware

> Parent: [backend/src](../README.md)

Express middleware. Each file exports factories that take their dependencies explicitly (no globals).

## Contracts

| Export | Behaviour |
|---|---|
| `requireAuth(tokens)` ([auth.ts](auth.ts)) | Accepts **only** `Authorization: Bearer <access token>` (never query string or cookies). Sets `req.user = { id, email }`; otherwise forwards a 401. |
| `requireTicket(tokens, sessionParam = 'id')` ([auth.ts](auth.ts)) | For GET stream endpoints: consumes the single-use `?ticket=`, checks it is bound to `req.params[sessionParam]`, sets `req.user`. |
| `currentUserId(req)` | The authenticated user id or a 401. **Routes take identity from here and nowhere else.** |
| `validate(schema, source = 'body')` ([validate.ts](validate.ts)) | zod validation of `body` / `query` / `params`; replaces `req[source]` with the parsed (stripped, coerced) value, so unknown fields never reach handlers. Failure: 400 `validation_error` with `issues: [{ path, message }]`. |
| `createLimiter({ perMinute, keyByUser?, message? })` ([rateLimit.ts](rateLimit.ts)) | Fixed 60 s window. Keyed by user id when `keyByUser` and authenticated, otherwise by client IP. Failure: 429 `rate_limited`; sends `RateLimit-*` (draft-7) headers. |
| `errorHandler(logger)`, `notFoundHandler` ([errorHandler.ts](errorHandler.ts)) | The last-resort mapper, below. |

### Error response format

```json
{ "error": "Human readable message", "code": "machine_code", "requestId": "…", "…extra": "…" }
```

| Source | Status | `code` |
|---|---|---|
| `AppError` | its own | its own |
| zod error | 400 | `validation_error` (+ `issues`) |
| malformed JSON | 400 | `invalid_json` |
| multipart parse / Multer error | 400 | `upload_error` |
| body or file too large | 413 | `payload_too_large` |
| `InvalidAgentContextError` | 403 | `forbidden` |
| database unreachable (Prisma `P1001`…, `SQLITE_BUSY`…) | 503 + `Retry-After: 5` | `service_unavailable` |
| unknown route | 404 | `not_found` |
| anything else | 500 | `internal_error` (generic message; details only in logs) |

Stack traces, file paths, SQL and library names never reach the client. If headers were already sent (a stream is in progress) the handler just ends the response.

## Tests

[`__tests__/errorHandler.unit.test.ts`](__tests__/errorHandler.unit.test.ts); behaviour through the routes in [routes/__tests__](../routes/__tests__); attacks in [tests/security](../../../tests/security/README.md).
