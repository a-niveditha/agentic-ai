# transports

> Parent: [backend/src](../README.md)

Non-HTTP-route transports. Currently the authenticated WebSocket chat; it reuses `ChatService`, so behaviour matches the SSE endpoints.

## WebSocket protocol ([wsServer.ts](wsServer.ts))

`attachWebSocketServer(httpServer, deps, { path = '/api/v1/ws', maxMessagesPerWindow = 10, windowMs = 10000, heartbeatMs = 30000 })`.

### Handshake (authentication happens before the connection exists)

```
GET /api/v1/ws?ticket=<single-use stream ticket>      (Upgrade: websocket)
```

1. Get a ticket with `POST /api/v1/auth/stream-ticket` (Bearer). It is valid ~60 s and usable once.
2. A browser `Origin` that is not on the `CORS_ORIGINS` allowlist is rejected with **403** (blocks cross-site WebSocket hijacking). Non-browser clients send no `Origin`.
3. A missing, expired, reused or wrongly typed ticket is rejected with **401**. Rejection goes through `verifyClient`, which produces a proper HTTP error on both Node and Bun.

### Messages

Client → server (JSON, max 64 KiB):

```jsonc
{ "type": "chat", "sessionId": "<uuid>", "text": "…" }   // text ≤ MAX_MESSAGE_CHARS
{ "type": "cancel" }                                        // abort the running turn
{ "type": "ping" }                                          // → { "type": "pong", "timestamp": … }
```

Server → client: the same event objects as SSE (`start`, `token`, `tool_start`, `tool_end`, `citation`, `error`, `done`; see [agent/events](../../../agent/src/agent/README.md)), JSON-encoded one per frame. On connect the server sends `start` with `{ message: 'connected' }`.

### Rules and errors (sent as `error` events, connection stays open)

| `code` | When |
|---|---|
| `validation_error` | Invalid JSON or schema, or text too long |
| `rate_limited` | More than `maxMessagesPerWindow` messages per window per connection |
| `session_busy` | A turn is already running on this connection / session |
| `not_found` | Session does not exist or is not the ticket owner's |
| `internal_error` | Unexpected failure (details only in logs) |

Ownership is checked per `chat` message, so a valid ticket for user A cannot chat in user B's session. Only one turn runs per connection; closing the socket aborts the running turn (model and tools stop). Ping/pong heartbeats terminate dead peers.

## Tests

[`__tests__/ws.unit.test.ts`](__tests__/ws.unit.test.ts). Cross-user and handshake attacks: [tests/security/tenantIsolation.sec.test.ts](../../../tests/security/tenantIsolation.sec.test.ts), [authn.sec.test.ts](../../../tests/security/authn.sec.test.ts).
