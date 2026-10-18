FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
COPY agent/package.json ./agent/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN bun install --frozen-lockfile --filter @agentic-ai/frontend --linker hoisted

FROM oven/bun:1.3.14 AS runtime-dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY agent/package.json ./agent/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN bun install --frozen-lockfile --filter @agentic-ai/frontend --production --omit=optional --linker hoisted

FROM dependencies AS builder
WORKDIR /app
COPY frontend ./frontend

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:5000
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun --filter @agentic-ai/frontend build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=builder --chown=node:node /app/frontend/.next/standalone ./
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/frontend/.next/static ./.next/static

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/login || exit 1

CMD ["node", "server.js"]
