# tools

> Parent: [agent/src](../README.md) · Sub-folders: [builtins](builtins/README.md)

How the agent gets capabilities: a base class for tools, a registry that decides who may use which tool, a per-run budget, and the built-in tools.

## Interface contracts

### `RegisteredTool` and `ToolSource` ([types.ts](types.ts))

```ts
interface ToolAuthPolicy { requiredScopes?: string[] }          // ALL listed scopes must be present

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly authPolicy: ToolAuthPolicy;
  build(context: AgentContext, options?: { signal?: AbortSignal; budget?: ToolBudget }): StructuredToolInterface;
}

interface ToolSource extends HealthCheckable {        // a dynamic set of tools, e.g. an MCP server
  listTools(): RegisteredTool[];
}
```

`build()` returns a LangChain tool **bound to one trusted context** for one run.

### `BaseAgentTool` ([BaseAgentTool.ts](BaseAgentTool.ts))

The template for writing a tool: extend it, set `name`, `description`, a zod `schema` (a `z.object`) and optionally `authPolicy`, and implement `run(input, context, signal)` returning `{ data, text?, citations? }`.

```ts
class MyTool extends BaseAgentTool<typeof schema> {
  readonly name = 'my_tool';
  readonly description = 'What the model should use it for.';
  readonly schema = z.object({ q: z.string().max(200) });
  override readonly authPolicy = { requiredScopes: ['my:scope'] };
  protected async run({ q }, ctx) { return { data: { ... }, text: '...' }; }
}
registry.register(new MyTool());
```

`execute(rawInput, context, signal)` guarantees, in order: authorization (`isAuthorized`, deny by default) → cancelled? → schema validation → `run()` → result. It **never throws**; every outcome is a `ToolEnvelope`:

```ts
{ ok: boolean; content: string; data?: unknown; citations: Citation[]; error?: { reason: string; retryable: boolean } }
```

- Throw `ToolUserError(message, retryable?)` for failures whose message is safe to show the model. Other errors are classified (`classifyError`) into friendly messages; unknown errors become a generic "failed unexpectedly" (details never reach the model).
- `content` is what the model reads (defaults to JSON of `data`). Fence external text with `fenceUntrusted()`.
- Tool schemas must **not** contain identity fields: take the user from `context.tenantId` / `context.principalId`.
- `build()` also enforces the shared `ToolBudget`.

### `ToolRegistry` ([ToolRegistry.ts](ToolRegistry.ts))

| Method | Contract |
|---|---|
| `register(tool)` / `unregister(name)` | Duplicate names throw. |
| `addSource(source)` | Adds a `ToolSource` (MCP). On a name clash the static tool wins. |
| `all()` | Static tools then source tools. |
| `authorizedFor(context)` | Tools whose policy this context satisfies; invalid / missing context → `[]`. |
| `getAuthorized(name, context)` | One tool or `undefined`. |
| `toolsFor(context, options?)` | LangChain tools for the agent. Unauthorised tools are **not offered** to the model. |
| `checkHealth()` | Aggregates source health; `degraded` (never `down`) when a source is down, since static tools still work. |

### `ToolBudget` ([budget.ts](budget.ts))

`new ToolBudget(limit)`, `tryConsume(): boolean`, `used`. One instance is shared by all tools of a run, so the cap applies across tools. When exhausted, a tool returns `BUDGET_EXHAUSTED_MESSAGE` and the model can still write a final answer (the run is not killed).

### Policy ([policy.ts](policy.ts))

`isAuthorized(policy, context)`: true only for a valid `AgentContext` that has every required scope.

## Files

| File | Purpose |
|---|---|
| [types.ts](types.ts) | `RegisteredTool`, `ToolSource`, `ToolAuthPolicy`, `BuildOptions` |
| [BaseAgentTool.ts](BaseAgentTool.ts) | Tool base class, `ToolUserError`, `ToolEnvelope` |
| [ToolRegistry.ts](ToolRegistry.ts), [policy.ts](policy.ts), [budget.ts](budget.ts) | Registry, authorization, budget |
| [builtins/](builtins/README.md) | The five shipped tools |
| [index.ts](index.ts) | Barrel export |

## Tests

[`__tests__/`](__tests__): `core` (base class, registry, policy), `budget`, `builtins` unit tests. Scope and identity attacks: [tests/security/tenantIsolation.sec.test.ts](../../../tests/security/tenantIsolation.sec.test.ts).
