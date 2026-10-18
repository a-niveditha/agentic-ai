# models

> Parent: [agent/src](../README.md)

LLM vendor abstraction. The agent and the RAG chain depend only on `ChatModelProvider`; Gemini is the one shipped implementation.

## Interface contract: `ChatModelProvider` ([ChatModelProvider.ts](ChatModelProvider.ts))

```ts
interface ChatModelOptions { temperature?: number; maxOutputTokens?: number }

interface ChatModelProvider extends HealthCheckable {
  readonly name: string;      // e.g. 'google-genai'
  readonly modelId: string;   // e.g. 'gemini-2.5-flash'
  assertAvailable(): void;    // throws CircuitOpenError when the vendor is known to be down
  createChatModel(options?: ChatModelOptions): BaseChatModel; // a LangChain chat model
}
```

Implementer obligations:

1. Own the credentials, retry policy and circuit breaker; callers never see keys.
2. `assertAvailable()` and `createChatModel()` must throw when no credentials are configured (the Gemini message mentions "API key", which `classifyError` maps to `auth`) instead of returning a model that fails later.
3. Feed call outcomes into the breaker so a dead vendor stops being called (see [resilience](../resilience/README.md)).
4. `checkHealth()` must not make a network call (so `/api/v1/ready` never burns quota). Report `down` for a missing or rejected key, otherwise the breaker's state.

## `GeminiChatModelProvider` ([GeminiChatModelProvider.ts](GeminiChatModelProvider.ts))

```ts
new GeminiChatModelProvider({
  apiKey?, model?, temperature?, maxRetries?, breaker?, callbacks?
})
```

Wraps `ChatGoogleGenerativeAI` (`name = 'google-genai'`, `componentName = 'llm:gemini'`, streaming on).

| Option | Default |
|---|---|
| `apiKey` | `GEMINI_API_KEY`, then `GOOGLE_API_KEY` |
| `model` | `GEMINI_MODEL`, then `gemini-2.5-flash` |
| `temperature` | `0.2` |
| `maxRetries` (LangChain-level, per request) | `2` |
| `breaker` | opens after 4 service failures, 20 s cooldown |
| `callbacks` | extra LangChain handlers (metrics, tracing, test pacing) |

A callback handler records each call's outcome in the breaker. After the vendor rejects the key, health is `down` straight away because retrying cannot help.

## Adding a vendor

Implement `ChatModelProvider` (return any LangChain `BaseChatModel`), then pass it to `ChatAgent` / `StandaloneRagChain`, or swap it in `backend/src/container.ts`. A fake for tests lives in [../testing](../testing/README.md).

## Tests

[`__tests__/gemini.unit.test.ts`](__tests__/gemini.unit.test.ts). Live behaviour is covered in [`../agent/__tests__/gemini.int.test.ts`](../agent/__tests__/gemini.int.test.ts).
