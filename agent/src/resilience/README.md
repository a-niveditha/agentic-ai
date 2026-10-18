# resilience

> Parent: [agent/src](../README.md)

Shared building blocks for graceful degradation. Every component that talks to something that can fail (model, embeddings, vector store, search, scraper, MCP, database) uses these instead of inventing its own error handling.

## Interface contracts

### `HealthCheckable` ([health.ts](health.ts))

```ts
type HealthStatus = 'up' | 'degraded' | 'down';
interface HealthReport { status: HealthStatus; detail?: string; checkedAt: number }
interface HealthCheckable {
  readonly componentName: string;
  checkHealth(): Promise<HealthReport>;
}
```

- `checkHealth()` must be cheap, must not throw for an unhealthy dependency (return `down`), and must never include secrets in `detail`.
- `collectHealth(components)` runs all checks in parallel; a check that throws is reported as `down`, never propagated.
- `aggregateHealth(reports)`: worst status wins (`down` > `degraded` > `up`).

### Error classification ([errors.ts](errors.ts))

`classifyError(err): ClassifiedError` maps any thrown value to `{ kind, retryable, serviceFailure, retryAfterMs?, message }`.

| `kind` | retryable | counts toward circuit breaker |
|---|---|---|
| `rate_limit` (429, quota) | yes | yes |
| `timeout`, `network`, `unavailable` (5xx) | yes | yes |
| `auth` (401/403, bad API key) | no | yes |
| `bad_request` (other 4xx) | no | no |
| `aborted`, `circuit_open`, `unknown` | no | no |

`friendlyMessage(kind, what)` returns a short, user-safe sentence (never raw provider payloads or keys). `CircuitOpenError` carries `circuit` and `retryAfterMs`.

### `CircuitBreaker` ([circuitBreaker.ts](circuitBreaker.ts))

States `closed → open → half-open`. After `failureThreshold` consecutive service failures the circuit opens for `cooldownMs`, then lets one probe through. API: `execute(fn)`, `assertAvailable()` (throws `CircuitOpenError`), `recordSuccess()`, `recordFailure(err)`, `reset()`, `state`, and it is itself a `HealthCheckable` (`open` → `down`, `half-open` → `degraded`).

### Retry ([retry.ts](retry.ts))

- `withRetry(fn, RetryOptions)`: exponential backoff with jitter, honours `Retry-After`, stops on abort, never retries non-retryable errors.
- `resilientCall(breaker, fn, opts)`: the standard wrapper for external calls. Every attempt goes through the breaker and an open circuit also stops retrying.

## Files

| File | Purpose |
|---|---|
| [health.ts](health.ts) | `HealthCheckable`, `collectHealth`, `aggregateHealth` |
| [errors.ts](errors.ts) | `classifyError`, `friendlyMessage`, `CircuitOpenError` |
| [circuitBreaker.ts](circuitBreaker.ts) | `CircuitBreaker` |
| [retry.ts](retry.ts) | `withRetry`, `resilientCall`, `sleep` |
| [index.ts](index.ts) | Barrel export |

## Tests

[`__tests__/`](__tests__) — `circuitBreaker`, `errors`, `health`, `retry` unit tests (injectable clocks and sleep, no real waiting).
