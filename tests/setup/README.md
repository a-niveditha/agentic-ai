# tests/setup

> Parent: [tests](../README.md)

## Contract: [preload.ts](preload.ts)

Registered in the root [bunfig.toml](../../bunfig.toml) as the Bun test preload; it runs before every test file.

- Reads `backend/.env` and fills **only variables that are not already set and not empty**; real environment variables always win. This is how live suites get `GEMINI_API_KEY` without a root `.env`.
- Sets `NODE_ENV=test` and defaults `LOG_LEVEL=silent`.
- Has no side effects beyond the environment: no servers, no files.
