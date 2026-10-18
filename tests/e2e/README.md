# tests/e2e

> Parent: [tests](../README.md)

## Contract: [userFlow.e2e.test.ts](userFlow.e2e.test.ts)

One dummy user walks through the entire product on the real stack (real Gemini, disk Chroma, SQLite), in order. Each step depends on the ones before it, so it is a single suite that must run serially (`bun run test:e2e`). It prints an "E2E REPORT" with one line per step. Skipped when no Gemini key is available.

| # | Step | Passes when |
|---|---|---|
| 1 | Sign up, log in, `me` | 201 / 200, profile matches |
| 2 | First chat message | Streamed reply, no tools used, session auto-titled |
| 3 | Upload txt, md, pdf, docx, html, csv, json, and add a page by URL | Each is accepted (`202`, `processing`), then polled to `ready`; list shows all |
| 3b | Re-upload an identical file | `409 duplicate_document` naming the original |
| 4 | One question per file type | `knowledge_base_search` was called, the answer contains the unique fact, and the citation points at that document's id |
| 5 | Calculator | `calculator` tool call succeeds; answer contains the exact product |
| 6 | Web search → `save_to_knowledge_base` → follow-up | The agent creates the document itself; a later question cites the saved page |
| 7 | `web_scrape` on request | The page is read and its URL cited |
| 8 | Memory (fresh session) | The agent recalls a name and colour from an earlier turn; 4 messages are stored |
| 9 | WebSocket with a single-use ticket | The ticket is accepted at the handshake and a full turn streams, ending in `done` with status `completed` (ticket reuse is covered by the security suite) |
| 10 | Standalone `/api/v1/rag/query` | Status `completed`, the exact fact in the answer, citation to the right document |
| 11 | Delete a document | 200; its vector count is 0 and a repeat question no longer cites it |
| 12 | Delete the session | Later fetch is 404 and no messages remain in the database |
| 13 | Final health | `/api/v1/ready` reports `database` and `vectorstore:chroma` as `up` |

Web search uses a fixed `SearchProvider` (DuckDuckGo throttles many networks); page fetching is live.
