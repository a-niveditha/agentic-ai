import dotenv from 'dotenv';
import { createServer } from 'node:http';
import { ChromaVectorStoreAdapter } from '@agentic-ai/agent';
import { createApp } from './app.js';
import { API_BASE } from './config/api.js';
import { ConfigError, loadConfig } from './config/env.js';
import { buildDependencies } from './container.js';
import { PrismaStorageAdapter } from './services/PrismaStorageAdapter.js';
import { attachWebSocketServer } from './transports/wsServer.js';

dotenv.config();

async function main() {
  const config = loadConfig();
  const deps = buildDependencies(config);
  const { logger } = deps;
  for (const w of config.warnings) logger.warn(w);

  // Optional dependencies must never block startup: connect in the background / with timeouts.
  if (deps.vectorStore instanceof ChromaVectorStoreAdapter) {
    void deps.vectorStore.tryConnect().then((ok) => (ok ? logger.info('Chroma connected') : logger.warn(`Chroma unreachable at ${config.CHROMA_URL}; knowledge base runs degraded until it is back`)));
  }
  await deps.mcp?.start();

  const app = createApp(deps);
  const server = createServer(app);
  const wss = attachWebSocketServer(server, deps);

  server.listen(config.PORT, () => {
    logger.info(`Listening on :${config.PORT}  (docs: ${config.docsEnabled ? `http://localhost:${config.PORT}${API_BASE}/docs` : 'disabled'}, ws: ${API_BASE}/ws)`);
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    wss.clients.forEach((c) => c.close(1001, 'server shutting down'));
    wss.close();
    server.close();
    // Let documents that are being indexed finish (a few seconds); anything left stays `processing` and can be retried.
    await Promise.race([deps.documents.whenIdle(), new Promise((r) => setTimeout(r, 7_000))]);
    await deps.documents.shutdown();
    await deps.mcp?.stop();
    if (deps.storage instanceof PrismaStorageAdapter) await deps.storage.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error(err);
  process.exit(1);
});
