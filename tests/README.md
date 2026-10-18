# tests

> Parent: [repository root](../README.md)

Cross-package test suites that exercise the real stack. Unit tests live next to the code they cover (`**/__tests__/*.unit.test.ts` under [agent/src](../agent/src/README.md) and [backend/src](../backend/src/README.md)); integration tests that cover one package are colocated as `*.int.test.ts`.

## Layers and how to run them

| Layer | Where | Uses | Command |
|---|---|---|---|
| Unit | colocated `*.unit.test.ts` | fakes only (scripted model, fake embeddings, in-memory stores); coverage reported | `bun run test:unit` |
| Integration | colocated `*.int.test.ts` + [integration/](integration/README.md) | **real** Gemini key, Chroma on disk, SQLite, a stdio MCP server | `bun run test:integration` |
| End-to-end | [e2e/](e2e/README.md) | one dummy user through the whole product on the real stack | `bun run test:e2e` |
| Security | [security/](security/README.md) | attack scenarios against the running app | `bun run test:security` |
| Everything | | | `bun run test` |

Typecheck (production code and tests): `bun run typecheck`.

## Sub-folders

| Folder | Purpose | Doc |
|---|---|---|
| [setup/](setup/) | Bun preload: loads `backend/.env` without overriding real env vars, sets `NODE_ENV=test`, silences logs | [README](setup/README.md) |
| [helpers/](helpers/) | Test harnesses: app builders, API client, SSE reader, Chroma launcher, fixtures, Gemini pacer | [README](helpers/README.md) |
| [fixtures/](fixtures/) | Static fixtures (stdio MCP server) | [README](fixtures/README.md) |
| [integration/](integration/) | API on real infrastructure | [README](integration/README.md) |
| [e2e/](e2e/) | Full user journey | [README](e2e/README.md) |
| [security/](security/) | Security regression suites | [README](security/README.md) |

## Prerequisites for live suites

- A Gemini key in `backend/.env` (`GEMINI_API_KEY`). Without it the live suites skip themselves.
- The `chroma` CLI is started and wiped by the helpers (`data/chroma-test`); you do not need to run it yourself.
- Free-tier quotas are per model per day. Live tests default to `gemini-3.5-flash-lite` (override with `GEMINI_TEST_MODEL`) and a request pacer (`GEMINI_TEST_GAP_MS`, default 6500 ms). Do not run the live suites in a loop.
- DuckDuckGo may throttle some networks; the e2e therefore uses a fixed search provider and live scraping of `example.com`.

Written results: [docs/security-audit.md](../docs/security-audit.md).
