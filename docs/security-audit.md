# Security audit

Scope: `agent/` (library) and `backend/` (Express API). `frontend/` was out of scope and was not modified.
Method: threat-model-driven tests written first, run against the real stack (SQLite via Prisma, Chroma on disk,
live Gemini where a model is involved), then fixes and regression tests for every finding.

Everything below is backed by an automated test. Run them with `bun run test:security` (plus `bun run test:unit`
for the library-level guards). Where a claim has no test, it is listed under *Residual risks*.

## Threat model

| Asset | Attacker | Main concern |
|---|---|---|
| Another user's chats, documents and vectors | Authenticated user (Mallory) | Cross-tenant read / write / delete |
| Accounts | Anonymous internet | Token forgery, credential stuffing, enumeration |
| Server network position | Any user who can make the server fetch a URL, including via the model | SSRF to localhost, cloud metadata, internal services |
| The model's behaviour | Author of any text the model reads (uploaded file, web page) | Indirect prompt injection used to call tools, leak data or write to the knowledge base |
| Availability | Anyone | Oversized, nested or compressed input; connection and request floods |
| Secrets | Anyone reading logs, errors or API docs | Token / hash / path / stack leakage |

## Defence in depth for tenant isolation

A request must pass three independent layers, so a bug in one does not expose data:

1. **SQL ownership.** Every Prisma query for sessions, messages and documents is scoped by the authenticated user id.
   A foreign id behaves exactly like a nonexistent one (404, no existence oracle).
2. **Vector store.** `VectorStoreAdapter` requires a `userId` on every call, applies it as a metadata filter, and
   `tenantGuard` drops any result whose owner is not the caller, even if the store returned it.
3. **Trusted tool context.** The `AgentContext` is built from the verified JWT, frozen, and bound to the tools of
   one run. Tool schemas do not contain identity fields, so the model cannot name another user; if it tries, the
   extra field is ignored and the call still runs as the caller.

## Findings and results

Severity reflects impact on a deployment of this template. "Fixed" means a regression test now pins the behaviour.

### Fixed during this work

| # | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| F1 | The legacy `/api/tools/append` route let any user register tools for all users | Critical | Route and mutable global registry removed; tools are registered by the host at startup | tool registry unit tests; hardening suite |
| F2 | Legacy RAG had no tenant filter: every user searched every user's documents | Critical | Mandatory `userId` filter, foreign-result drop, collection name includes the embedding model | `tenantIsolation.sec.test.ts` (documents & vectors) |
| F3 | Legacy agent let the model choose tool arguments including identity | High | Frozen `AgentContext` bound per run; scope-based `authPolicy`; unauthorised tools are not offered | `tenantIsolation` (agent tools), ChatAgent unit tests |
| F4 | `JWT_SECRET` had a hard-coded fallback | High | Required, no default; production refuses weak secrets and wildcard CORS | `hardening` (startup refuses weak secrets) |
| F5 | SSE and WebSocket needed auth but a JWT in the URL leaks into logs and history | High | Single-use stream tickets: 60 s, `aud: stream`, `typ: stream`, accepted only on stream endpoints, bound to a session; a ticket is useless as a Bearer token | `authn` (stolen ticket), `tenantIsolation` (streaming) |
| F6 | Scraper and "import by URL" could reach internal services | High | SSRF guard: http(s) only, DNS-resolved addresses must all be public, redirects revalidated, connection pinned to the validated IP (closes DNS rebinding) | `ssrf.sec.test.ts` (5 tests incl. canary server that must never be contacted) |
| F7 | A docx / zip bomb could exhaust memory | High | Central-directory pre-check on entry count, total size and compression ratio before inflating | `hardening` and `loaders.unit.test.ts` |
| F8 | Files could lie about their type (PDF renamed `.txt`, ELF as `.md`) | Medium | Extension and magic-byte sniffing must agree; binaries and archives rejected | `hardening` (magic-byte mismatches, executable payloads) |
| F9 | Multipart parse errors surfaced as 500 and the URL schema accepted `ftp:` | Low | 400 for parse errors; http(s) only | API integration tests |
| F10 | `multer` 1.x has known vulnerabilities | Medium | Upgraded to 2.4.0 | document route tests, `hardening` upload tests |
| F11 | Gemini errors could leak provider details | Low | `classifyError` and friendly messages; internals never reach the client or the model | `hardening` (information leaks) |
| F12 | Run ended with `limit_reached` and no answer once a session had a long history | Medium (availability, found by the end-to-end run) | The model-call counter ignores messages re-emitted by middleware nodes | ChatAgent regression tests |

### Authentication (`authn.sec.test.ts`, 15 tests)

- `alg:none` (several spellings), wrong secret, different algorithm, tampered claims, expired tokens, wrong issuer,
  missing type and unexpected audience are all rejected.
- Only a well-formed `Authorization: Bearer` header is accepted. Credentials in URLs (other than the stream ticket
  on stream endpoints) and in cookies are ignored.
- Passwords: bcrypt with a cost factor, minimum and maximum length (bcrypt truncation / DoS guard), hashes never
  returned. SQL-injection payloads, object-shaped credentials and prototype-pollution bodies are inert.
- Login is rate limited per IP and does not reveal whether an account exists (same status and body, comparable
  timing). Email is case-insensitive unique and trimmed; concurrent signups for one email create exactly one account.

### Tenant isolation (`tenantIsolation.sec.test.ts`, 12 tests)

- Mallory cannot list, read, rename, delete or post into Alice's sessions, and cannot get, delete, retry or list her
  documents. A foreign resource is indistinguishable from a missing one.
- Forged `userId` / tenant fields in bodies, headers, queries and multipart fields have no effect.
- Standalone RAG and the chat agent return nothing of Alice's to Mallory, including when the model is made to name
  Alice. A page saved by Mallory's agent lands only in Mallory's knowledge base. Identical uploads by two users
  stay separate and deleting one leaves the other intact.
- Duplicate detection is per user (a unique `(userId, contentHash)` constraint), so uploading identical content to another account is accepted and a `409 duplicate_document` can never reveal that someone else holds it. Background indexing jobs are per user too: retry and delete on a foreign document are 404.
- A stream ticket bound to Alice's session is useless to Mallory and vice versa, over SSE and WebSocket.
- A tool outside the caller's scopes is not offered to the model and cannot be executed.

### SSRF (`ssrf.sec.test.ts`)

Loopback, RFC 1918 ranges, link-local (`169.254.169.254`), IPv6 loopback / ULA / mapped addresses, `file://`,
`gopher://`, credentials in URLs, redirects to private addresses, and a hostname that resolves public then private
are all refused, through three entry points: document import by URL, the `web_scrape` tool and
`save_to_knowledge_base`. A canary HTTP server proves nothing was ever contacted. Error text shown to the model
does not reveal internal network details.

### Indirect prompt injection (`injection.sec.test.ts`)

Retrieved passages, search results and scraped pages are placed in `<untrusted>` fences that content cannot close,
and the system prompt tells the model to treat them as data. Because injection cannot be fully prevented at the
prompt level, the design limits what a hijacked model can do:

- tools run as the real user with only that user's scopes, so injected text cannot cross tenants;
- a per-run `ToolBudget` caps how many calls injected text can trigger;
- `mcp` and other high-risk scopes are opt-in (default scopes are `kb:read,kb:write,web`);
- answering a normal question about a poisoned document does not execute its instructions (tested with live Gemini).

### Input hardening and leaks (`hardening.sec.test.ts`, 19 tests)

Zip bombs, oversized uploads (413, nothing stored), executables / scripts / archives, magic-byte mismatches, deeply
nested JSON, huge headers, oversized messages and session counts, unicode edge cases, path traversal in URLs and
ids all end in a clean 4xx or an intact round trip, never a 5xx or a crash. Helmet headers are present, CORS never
reflects arbitrary origins or allows credentials, SSE responses are not cacheable or bufferable. Error responses
carry no stack traces, paths, SQL or library names; logs redact tokens, tickets, passwords and hashes; API docs
expose no secrets; `/api/v1/ready` returns coarse statuses only.

### Graceful degradation as a security property

A component failing never widens access. When Chroma is down, uploads fail safely and the knowledge-base tool
reports unavailable; when the model rejects the key, the user gets a friendly message and nothing internal; a
crashed MCP server's tools are dropped rather than falling back to anything less checked. See the outage tests in
`tests/integration/api.int.test.ts`.

## Dependency audit (`bun audit`)

| Package | Issue | Where | Status |
|---|---|---|---|
| `multer` 1.x | known DoS advisories | backend | **Fixed** (2.4.0) |
| `next` < 15.5.16 | 2 critical, many high (RCE on Windows hosts, image optimizer, SSRF in server actions, DoS) | **frontend only** | **Not fixed: frontend was out of scope.** Upgrade to ≥ 15.5.16 before deploying the UI |
| `postcss`, `braces`, `postcss-selector-parser` | DoS / file-read in build tooling | frontend build chain | Not fixed (frontend) |
| `sharp` < 0.35 | libvips / libheif / librsvg CVEs | `agent` via `@huggingface/transformers` (local embeddings) | Not exploitable here: the agent never processes images. Pin or override when upgrading `@huggingface/transformers` |
| `sprintf-js` | DoS via unbounded precision | `mammoth`, `@langchain/community`, `swagger-jsdoc` | Low: not reachable with attacker-controlled format strings. Track upstream |

## Residual risks and recommendations

1. **Rotate `JWT_SECRET`.** The value in `backend/.env` equals the public example. The app refuses weak secrets in
   production, but local `.env` files are not rotated automatically.
2. **Stream tickets are single-use per process.** The used-ticket store is in memory, so a multi-instance
   deployment needs a shared store (Redis) or sticky sessions to keep the single-use guarantee.
3. **Signup reveals existing emails (409).** This is a deliberate usability trade-off; login does not enumerate.
   Switch to an email-verification flow if enumeration matters for your product.
4. **Prompt injection is mitigated, not eliminated.** Keep high-impact tools (MCP, write tools) behind scopes and
   add human confirmation for irreversible actions before enabling them for untrusted users.
5. **Rate limits are per IP and in memory.** Behind a proxy set the trusted-proxy configuration correctly, and use a
   shared store when running several instances.
6. **DuckDuckGo scraping is best-effort** and may be throttled; it is a reliability, not a security, issue. Use a
   keyed provider through `FallbackSearchProvider` in production.
7. **No malware scanning of uploads.** Files are type-checked and parsed, never executed or served back raw.
8. **Free-tier Gemini quotas** can cause 429s that degrade chat; handled gracefully but not a substitute for a paid key.
