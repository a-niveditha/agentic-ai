# prisma

> Parent: [backend](../README.md)

Database schema (SQLite through Prisma). The only consumer is [`PrismaStorageAdapter`](../src/services/PrismaStorageAdapter.ts); everything else goes through the [`AbstractStorageAdapter`](../src/services/README.md) port, so another database means another adapter, not a schema port.

## Data contract ([schema.prisma](schema.prisma))

| Model | Fields | Rules |
|---|---|---|
| `User` | `id` (uuid), `email` (**unique**, stored lower-case and trimmed), `passwordHash` (bcrypt), `name`, timestamps | Deleting a user cascades to sessions and documents. |
| `ChatSession` | `id`, `userId` → User, `title` (default "New Conversation"), timestamps | Index `(userId, updatedAt)`. Deleting cascades to messages. |
| `ChatMessage` | `id`, `sessionId` → ChatSession, `sender` (`user` \| `agent`), `content`, `metadata` (JSON string: `status`, `citations`, `toolCalls`, `error`), `createdAt` | Index `(sessionId, createdAt)`. |
| `Document` | `id`, `userId` → User, `filename`, `mimeType`, `sourceUrl?`, `status` (`processing` \| `ready` \| `failed`), `errorMessage?`, `chunksCount`, `content?`, `contentHash?`, timestamps | Index `(userId, createdAt)`; **unique `(userId, contentHash)`**, which makes duplicate detection atomic. `contentHash` is internal and never returned by the API. `content` is the extracted text kept so a failed or obsolete index can be rebuilt (retry, re-embedding) without a re-upload; it is never returned by the API. |

The `Document.id` is also the `sourceId` of that document's vector chunks, which is how deletes and re-indexing find them.

## Operations

- `DATABASE_URL` (default `file:./dev.db`) selects the database file; `dev.db` here is a local development database and is not part of the contract.
- Apply schema changes with the Prisma CLI (`bun run db:push` in `backend/` for local development, migrations for production) and regenerate the client with `bun run db:generate`.
- The integration test [`prismaStorage.int.test.ts`](../src/services/__tests__/prismaStorage.int.test.ts) runs the storage contract against a real SQLite file.
