# Frontend

Next.js workspace for chat, knowledge-base management, standalone RAG, and service status.

Run with: bun run dev:frontend

The API origin defaults to http://localhost:5000. Copy frontend/.env.example to frontend/.env.local to set NEXT_PUBLIC_API_BASE_URL. Add the frontend origin to backend CORS_ORIGINS.

## Docker

The root Compose file runs the frontend, backend, and Chroma together. Copy `.env.example` to
the root `.env`, set `JWT_SECRET` (for example, `openssl rand -base64 48`), then run
`docker compose up --build` and open http://localhost:3000. The API is available at
http://localhost:5000 and Chroma at http://localhost:8000. SQLite persists in the `backend_data`
Docker volume; Chroma persists in `data/chroma`.

The browser calls the API directly, so `NEXT_PUBLIC_API_BASE_URL` must be reachable from the
browser and match an origin allowed by `CORS_ORIGINS`. The public API setting is embedded in the
frontend bundle at build time; rebuild the image after changing it. `FRONTEND_PORT` and
`BACKEND_PORT` change the host ports. To run only the UI against an existing API, use
`docker compose up --build --no-deps frontend` and set `NEXT_PUBLIC_API_BASE_URL` as needed.

Checks:

- `bun --filter @agentic-ai/frontend typecheck`
- `bun --filter @agentic-ai/frontend test:unit`
- `bun --filter @agentic-ai/frontend test:integration`
- `bun --filter @agentic-ai/frontend test:e2e`
- `bun --filter @agentic-ai/frontend build`

The browser suite starts a local Next.js server, mocks the API, and uses installed Google Chrome. Root scripts `bun run test:unit`, `bun run test:integration`, and `bun run test:e2e` include the frontend suites alongside the existing monorepo tests.
