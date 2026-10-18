# testing

> Parent: [agent/src](../README.md)

Deterministic fakes, exported from the package so downstream apps can test their own tools and flows without a real LLM or embeddings API.

## Contracts

### `ScriptedChatModel` / `ScriptedChatModelProvider` ([ScriptedChatModel.ts](ScriptedChatModel.ts))

A `BaseChatModel` that replays a script and implements `ChatModelProvider` (see [models](../models/README.md)).

```ts
type ScriptedTurn =
  | { text: string; toolCalls?: ScriptedToolCall[] }
  | { toolCalls: ScriptedToolCall[]; text?: string }
  | { error: Error }
  | ((messages: BaseMessage[]) => { text?; toolCalls? } | { error: Error });
interface ScriptedToolCall { name: string; args: Record<string, unknown>; id?: string }

new ScriptedChatModelProvider(script, repeatLast = false)
```

- One turn per model call, in order. With `repeatLast` the last turn repeats forever (to test iteration limits). Without it, a call past the end of the script throws `ScriptedChatModel: script exhausted`.
- Streams text token by token; supports tool calls (including parallel calls in one turn).
- `provider.lastModel.received` records every prompt the model was given, so tests can assert on history, summaries and tool results.

### `FakeEmbeddingProvider` ([FakeEmbeddingProvider.ts](FakeEmbeddingProvider.ts))

Deterministic bag-of-words hash embeddings (`new FakeEmbeddingProvider(dims = 128)`): the same text always yields the same vector, and texts sharing words are close. Meets the full `EmbeddingProvider` contract (`metadata` is `{ provider: 'fake', modelId: 'hash-<dims>', dimensions }`).

Test hooks: `failNext = n` makes the next `n` embedding calls throw a 503-style error (to test retry and degradation); `calls` counts calls. For unit tests only: its vectors carry no real semantics.

## Files

| File | Purpose |
|---|---|
| [ScriptedChatModel.ts](ScriptedChatModel.ts) | Scripted chat model and provider |
| [FakeEmbeddingProvider.ts](FakeEmbeddingProvider.ts) | Deterministic embeddings |
| [index.ts](index.ts) | Barrel export |

## Tests

[`__tests__/scripted.unit.test.ts`](__tests__/scripted.unit.test.ts)
