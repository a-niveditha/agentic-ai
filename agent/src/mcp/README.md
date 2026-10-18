# mcp

> Parent: [agent/src](../README.md)

MCP **client** support: tools from external Model Context Protocol servers are exposed to the agent as ordinary tools behind the same scope policy. Startup never blocks or fails because an MCP server is down.

## Interface contracts

### Configuration ([config.ts](config.ts))

Operator-controlled JSON (default path from `MCP_CONFIG_PATH`; see [mcp.config.example.json](../../../mcp.config.example.json)). A missing file means "no MCP servers". It is **never** user input.

```jsonc
{ "servers": { "<name>": {          // name: letters, digits, _ and - only
    "transport": "stdio" | "http",  // default stdio
    "command": "...", "args": [], "env": {},   // stdio requires command
    "url": "...", "headers": {},                // http requires url
    "requiredScopes": ["mcp"],      // default; callers need ALL of these
    "toolTimeoutMs": 30000
} } }
```

`loadMcpConfig(path)` validates with zod (`McpConfigSchema`) and throws on an invalid file.

### `McpToolSource` implements `ToolSource` ([McpToolSource.ts](McpToolSource.ts))

```ts
const mcp = new McpToolSource(config, { clientFactory?, connectTimeoutMs = 15000, reconnectBaseMs = 2000, reconnectMaxMs = 60000, logger? });
await mcp.start();        // connects to all servers in parallel; NEVER throws
registry.addSource(mcp);  // listTools() returns tools of servers that are currently up
mcp.serverStatus();       // { [name]: { status: 'connecting'|'up'|'down', tools, lastError? } }
await mcp.stop();
```

- Tool names are prefixed `<server>_<tool>` so servers cannot shadow built-ins.
- Each tool is wrapped with the server's `requiredScopes` (default `mcp`, which is **not** in the default user scopes: grant it only to trusted users), the per-call `toolTimeoutMs`, and the run's `ToolBudget`.
- A server that fails to start is skipped with a warning and reconnected in the background with exponential backoff. Only network-type failures take a server down; a single tool timeout does not.
- `McpClientLike` (`listTools()`, `close()`) is the seam for tests; the default factory uses `MultiServerMCPClient` from `@langchain/mcp-adapters`.

## Files

| File | Purpose |
|---|---|
| [config.ts](config.ts) | Config schema and loader |
| [McpToolSource.ts](McpToolSource.ts) | Connection management, tool wrapping, reconnect |
| [index.ts](index.ts) | Barrel export |

## Tests

[`__tests__/mcp.unit.test.ts`](__tests__/mcp.unit.test.ts) (fake clients), [`__tests__/mcp.int.test.ts`](__tests__/mcp.int.test.ts) (real stdio server from [tests/fixtures](../../../tests/fixtures/README.md)).
