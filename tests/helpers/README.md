# tests/helpers

> Parent: [tests](../README.md)

Shared harnesses. They are plain TypeScript modules imported by the suites (not tests themselves).

| File | Exports and contract |
|---|---|
| [testApp.ts](testApp.ts) | `startTestApp({ script?, repeatLast?, env?, overrides? })` boots the **real** `createApp` on an ephemeral port with a scripted model, fake embeddings, in-memory vector store and storage, a `FakeSearchProvider` and `FakeScraper`. Returns a `TestHarness`: `deps`, `storage`, `model` (the scripted provider), `embeddings`, `search`, `scraper`, `server.url`, `close()`. `testConfig(env)` builds an `AppConfig`; `TEST_JWT_SECRET`. No network, no quota. |
| [liveApp.ts](liveApp.ts) | `startLiveApp({ name, env?, modelProvider?, searchProvider?, scraper? })` boots the app on **real** Gemini (paced), disk Chroma and temporary SQLite, and returns a `LiveHarness` (`deps`, `chroma`, `server`, `prisma`, `vectorStore`, `close()`); `tempPrismaStorage()` gives a fresh Prisma storage plus `cleanup()`. |
| [chroma.ts](chroma.ts) | `startChroma(name)` starts `chroma run --path data/chroma-test/<name>` on a free port, waits until ready, returns a `ChromaServer` with `url`, `stop()`, `kill()` (an outage without wiping data) and `restart()` (recovery on the same port and data); data is wiped on start. |
| [gemini.ts](gemini.ts) | `geminiApiKey`, `TEST_MODEL`, `pacedGemini(overrides)`: a `GeminiChatModelProvider` whose calls share one pacer (≈ 6.5 s gap) to stay under free-tier rate limits. |
| [http.ts](http.ts) | `ApiClient(base)` with `request()` (raw `Response`), `json()` (`{ status, body, headers }`), `signup()` (stores the token in `client.token`), `upload()` (multipart); sends `Authorization` automatically, `readSse(res)`, `tokensOf(events)`, `ofType(events, type)`, `listen(handler)`. |
| [fixtures.ts](fixtures.ts) | `FACTS` (a unique question/answer per file kind), builders for PDF, DOCX and HTML, `buildFixtureFiles()` returning one file per supported type. |
| [clientProcess.ts](clientProcess.ts) | `spawnStreamingClient(url, token, body)`: a Node child process that streams a chat and can be killed, to test real client disconnects (the in-process client cannot truly close the TCP connection under Bun). |
| [canary.ts](canary.ts) | `startCanary()`: a local HTTP server that records every request it receives (`hits`); SSRF tests assert it was never contacted. |
| [slowTool.ts](slowTool.ts) | `SlowTool`: a tool that waits on the abort signal, to test cancellation propagation. |

Rules: helpers never touch the real `data/chroma` folder or the developer's `dev.db`, and they always clean up what they start.
