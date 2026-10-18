FROM oven/bun:1.3.14 AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
COPY agent/package.json ./agent/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN bun install --frozen-lockfile --filter @agentic-ai/backend --linker hoisted

FROM dependencies AS builder
WORKDIR /app
COPY agent ./agent
COPY backend ./backend
RUN bunx prisma generate --schema backend/prisma/schema.prisma

FROM oven/bun:1.3.14 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000
ENV DATABASE_URL=file:/data/app.db

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/backend ./backend

WORKDIR /app/backend
EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD bun -e 'fetch("http://127.0.0.1:5000/api/v1/ready").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["sh", "-c", "bunx prisma db push --schema prisma/schema.prisma && bun src/index.ts"]
