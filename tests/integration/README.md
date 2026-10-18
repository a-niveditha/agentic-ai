# tests/integration

> Parent: [tests](../README.md)

## Contract: [api.int.test.ts](api.int.test.ts)

The whole backend on **real infrastructure**: Gemini (paced), a disk-backed Chroma server and SQLite, started by [`startLiveApp`](../helpers/README.md). It is skipped automatically when no Gemini key is available. Run with `bun run test:integration` (which also runs the colocated `*.int.test.ts` files of `agent` and `backend`).

What it proves:

| Scenario | Assertion |
|---|---|
| Readiness | Every real component reports `up`, including `database` and `vectorstore:chroma` |
| Ingestion of every file type | Each upload is accepted (`202`) and becomes `ready`, with rows in SQLite and vectors in Chroma |
| Standalone RAG | Each document's question is answered with a citation to the right document |
| Tenant isolation | A second user gets nothing from the first user's documents (RAG and list) |
| Deletion | Removes the row **and** the vectors; the document is no longer retrievable |
| Chroma outage | The server stays up and reports degradation; an upload is accepted, retried, and ends as a `failed` document that `/retry` recovers once Chroma is back |
| Invalid model key | Chat returns a friendly error (never the key or provider text) and keeps the conversation; uploads still index; RAG degrades to passages; readiness shows the LLM `down` |

Other integration tests live next to the code they cover:

- [agent/src/rag/stores/__tests__/chroma.int.test.ts](../../agent/src/rag/stores/__tests__/chroma.int.test.ts): Chroma adapter with real Gemini embeddings
- [agent/src/agent/__tests__/gemini.int.test.ts](../../agent/src/agent/__tests__/gemini.int.test.ts): agent loop and tool calls on live Gemini
- [agent/src/mcp/__tests__/mcp.int.test.ts](../../agent/src/mcp/__tests__/mcp.int.test.ts): MCP client against the stdio fixture
- [agent/src/web/__tests__/web.int.test.ts](../../agent/src/web/__tests__/web.int.test.ts): live scraping and search
- [backend/src/services/__tests__/prismaStorage.int.test.ts](../../backend/src/services/__tests__/prismaStorage.int.test.ts): storage contract on SQLite
