# lib

> Parent: [backend/src](../README.md)

Small framework-independent building blocks used by routes, middleware and transports.

## Contracts

### Errors ([errors.ts](errors.ts))

`AppError(status, code, message, extra?, headers?)` is the only error type that carries an HTTP meaning; the central [error handler](../middleware/README.md) renders it as `{ error, code, requestId, ...extra }`. Helpers: `badRequest` (400), `unauthorized` (401), `forbidden` (403), `notFound(what)` (404), `conflict` (409), `unavailable(msg, retryAfterSeconds)` (503 + `Retry-After`). Messages must be safe to show to clients.

### Tokens ([tokens.ts](tokens.ts))

`new TokenService({ secret, accessTtl, ticketTtlSeconds, now? }, ticketStore?)`. Two token types that are never interchangeable (HS256 only, issuer `agentic-ai`):

| | Access token | Stream ticket |
|---|---|---|
| Claims | `typ: access`, `sub`, `email` | `typ: stream`, `aud: stream`, `sub`, optional `sid` (session), `jti` |
| Lifetime | `ACCESS_TOKEN_TTL` (7 d) | `STREAM_TICKET_TTL_SECONDS` (60 s) |
| Accepted | `Authorization: Bearer` only | `?ticket=` on the stream endpoint and the WebSocket handshake only |
| Use | many times | **once** (`jti` consumed) |

Methods: `signAccess(user)`, `verifyAccess(token)`, `signTicket(userId, sessionId?)` → `{ ticket, expiresInSeconds }`, `consumeTicket(token, expectedSessionId?)`. Every failure is a 401 `invalid_token` / `invalid_ticket` with no detail about why.

`TicketStore` (`consume(jti, expiresAtMs): boolean`) is the single-use guard. The default `InMemoryTicketStore` works for one process; **implement it over Redis for multi-instance deployments**.

### Logger ([logger.ts](logger.ts))

`createLogger(level, destination?)`: pino with redaction of `authorization`, cookies, `password`, `passwordHash`, `apiKey`, `token`, `ticket`. `redactUrl(url)` masks `ticket`, `token`, `key`, `api_key`, `auth_token` query values.

### SSE ([sse.ts](sse.ts))

`openSse(req, res, { heartbeatMs })` starts a `text/event-stream` response (no cache, no buffering) and returns `SseChannel { send(event), signal, close(), open }`.

- Frames are `data: <json>\n\n`; keep-alive frames are `: keep-alive` comments.
- `signal` aborts when the client disconnects, which propagates to the model and tools. The heartbeat doubles as a liveness probe because Bun emits no disconnect event once the request body has been read.
- `send` after close is a no-op; `close()` is idempotent and removes socket listeners.

## Tests

[`__tests__/tokens.unit.test.ts`](__tests__/tokens.unit.test.ts), [`__tests__/misc.unit.test.ts`](__tests__/misc.unit.test.ts) (errors, logger, SSE). Token attacks: [tests/security/authn.sec.test.ts](../../../tests/security/authn.sec.test.ts).
