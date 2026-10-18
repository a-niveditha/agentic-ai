# agent

> Parent: [agent/src](../README.md)

The chatbot runtime: a tool-using agent built on LangChain v1 `createAgent`, a stable stream-event vocabulary, and conversation memory.

## Interface contracts

### `ChatAgent` ([ChatAgent.ts](ChatAgent.ts))

```ts
new ChatAgent({ modelProvider, registry, systemPrompt?, assistantName? })
agent.run(input: RunInput): Promise<ChatAgentResult>

interface RunInput {
  messages: HistoryMessage[];     // prior turns + the new user message LAST
  context: AgentContextInput;     // trusted identity and budgets, see ../context.ts
  summary?: string;               // from prepareHistory()
  signal?: AbortSignal;
  onEvent?: (e: StreamEvent) => void;
}
interface ChatAgentResult {
  status: 'completed' | 'interrupted' | 'limit_reached' | 'error';
  answer: string; citations: Citation[]; toolCalls: { id, name, input, ok? }[];
  error?: { message: string; code: string };
}
```

Guarantees:

1. **Never throws for operational failures.** Model down, rate limits, bad key, tool failures, aborts and limits all come back as a `status` plus a friendly message (`error.code`: `model_unavailable`, `model_error`, `empty_response`). The only throw is `InvalidAgentContextError` for a malformed context, which is a programming / security error.
2. **One instance is reusable and concurrency-safe;** every `run()` validates and freezes the context and binds it to freshly built tools.
3. **Only tools the context is authorised for are offered** (`registry.toolsFor`).
4. **Bounded.** `budget.maxToolCalls` is enforced inside the tools through a shared `ToolBudget` (over-budget calls get a message telling the model to answer with what it has, so the run still ends with an answer). `budget.maxModelCalls` is enforced by `modelCallLimitMiddleware`; hitting it yields `limit_reached` with the best partial answer.
5. **Cancellation.** An aborted signal before or during the run yields `interrupted` with whatever was generated.
6. Tool results are treated as untrusted: the system prompt includes `UNTRUSTED_NOTICE` and tools fence external text.
7. Each tool call and citation is reported once, however LangGraph re-emits messages. Only the `model_request` and `tools` graph nodes carry new messages; middleware nodes re-emit the whole history and are ignored (regression-tested).

### Stream events ([events.ts](events.ts))

```ts
type StreamEventType = 'start' | 'token' | 'tool_start' | 'tool_end' | 'citation' | 'error' | 'done';
interface StreamEvent { type: StreamEventType; payload: any; timestamp: number }
```

| type | payload |
|---|---|
| `start` | `{ message, executionId }` |
| `token` | `{ token }` (answer text only, never tool-call fragments) |
| `tool_start` | `{ id, tool, input }` |
| `tool_end` | `{ id, tool, success, output }` (output ≤ 4 000 chars) |
| `citation` | `{ citations: Citation[] }` |
| `error` | `{ message, code }` |
| `done` | `{ fullResponse, citationsCount, status }`; the backend adds `sessionId` and `messageId` |

Order: `start`, then any `tool_start` / `tool_end` / `citation` / `token`, then optionally `error`, and **always** a final `done`. This is the wire format of the backend's SSE and WebSocket streams.

### Memory ([memory.ts](memory.ts))

`prepareHistory(history, { maxMessages = 30, maxChars = 24000, keepRecent = 10, summarizer?, signal? })` returns `{ messages, summary?, trimmed, summarizationFailed? }`.

- Under both limits, history is returned untouched.
- Otherwise the most recent `keepRecent` messages are kept (never starting with an assistant turn, always keeping the last message) and older ones are condensed into a summary by the optional `summarizer` model.
- If summarising fails for any reason, it silently falls back to plain trimming; it can never break a chat turn.

## Files

| File | Purpose |
|---|---|
| [ChatAgent.ts](ChatAgent.ts) | Agent runtime, `textOf` helper |
| [events.ts](events.ts) | Event types and `createEvent` |
| [memory.ts](memory.ts) | History preparation |
| [index.ts](index.ts) | Barrel export |

## Tests

[`__tests__/`](__tests__): `chatAgent` and `memory` unit tests (scripted model); `gemini.int.test.ts` runs the agent against live Gemini.
