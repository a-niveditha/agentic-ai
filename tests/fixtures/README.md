# tests/fixtures

> Parent: [tests](../README.md)

## Contract: [mcp-test-server.mjs](mcp-test-server.mjs)

A minimal real MCP server over **stdio** (newline-delimited JSON-RPC 2.0), used by the MCP integration test and the e2e/security suites so the MCP client is tested against a genuine process rather than a mock.

| Tool | Arguments | Behaviour |
|---|---|---|
| `echo` | `{ text }` | Returns the text |
| `add` | `{ a, b }` | Returns the sum |
| `crash` | `{}` | Kills the server process (tests reconnect and degradation) |
| `slow` | `{ ms }` | Sleeps, then answers (tests per-tool timeouts) |

Binary file fixtures (PDF, DOCX, HTML …) are not stored; they are generated in code by [helpers/fixtures.ts](../helpers/fixtures.ts) so each carries a unique fact that answers can be checked against.
