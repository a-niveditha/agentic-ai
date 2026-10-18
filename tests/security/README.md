# tests/security

> Parent: [tests](../README.md)

Security regression suites. They run against the real app (`startTestApp` for most; real SQLite, real Gemini or Chroma where the property needs it) and assert **attacks fail**. Run with `bun run test:security`. The narrative, findings and residual risks are in [docs/security-audit.md](../../docs/security-audit.md); the table below maps each suite to the guarantee it pins.

| Suite | Guarantee |
|---|---|
| [tenantIsolation.sec.test.ts](tenantIsolation.sec.test.ts) | User B cannot list, read, rename, delete, retry or post into user A's sessions and documents; foreign ids look like missing ones (404); forged identity fields in bodies, headers, queries and form fields are ignored; RAG and chat never return A's data to B, even if the model names A; pages saved by B's agent land only in B's knowledge base; scoped tools are not offered or runnable without the scope; stream tickets and WebSocket sessions are bound to their owner |
| [authn.sec.test.ts](authn.sec.test.ts) | Forged JWTs (`alg:none` in several spellings, wrong secret or algorithm, tampered, expired, wrong issuer, wrong type, wrong audience) are rejected; a stream ticket is useless as a Bearer token; credentials only from the `Authorization` header; password length bounds; SQL / NoSQL / prototype-pollution payloads are inert; bcrypt hashes are never exposed; login is rate limited and does not reveal whether an account exists; email uniqueness is case-insensitive and race-free |
| [ssrf.sec.test.ts](ssrf.sec.test.ts) | Import-by-URL, `web_scrape` and `save_to_knowledge_base` refuse loopback, private, link-local / metadata, IPv6, non-http schemes and credentials in URLs; DNS rebinding and redirects to private addresses are blocked; error text reveals no network details; a canary server proves nothing internal was contacted |
| [injection.sec.test.ts](injection.sec.test.ts) | Untrusted text (documents, search results, pages) stays fenced and cannot close its fence; the system prompt labels it as data; injected instructions do not trigger tools on their own and cannot exceed the user's scopes or budget; a poisoned document does not hijack an answer (live model) |
| [hardening.sec.test.ts](hardening.sec.test.ts) | Zip bombs, oversized, executable, archive and type-spoofed uploads are rejected; hostile JSON, headers, unicode and path traversal never cause a 5xx; helmet headers, tight CORS, uncacheable SSE; no stack traces, paths, SQL, secrets or hashes in responses and logs; coarse readiness; production refuses weak secrets and wildcard CORS |

When you fix a vulnerability, add the failing attack here first.
