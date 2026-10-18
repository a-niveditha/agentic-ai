import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChromaVectorStoreAdapter, CircuitBreaker, DuckDuckGoSearchProvider, GeminiEmbeddingProvider, HttpScraper, type ChatModelProvider, type Scraper, type SearchProvider } from '../../agent/src/index.js';
import { createApp } from '../../backend/src/app.js';
import { buildDependencies, type Dependencies } from '../../backend/src/container.js';
import { createLogger } from '../../backend/src/lib/logger.js';
import { PrismaClient, PrismaStorageAdapter } from '../../backend/src/services/PrismaStorageAdapter.js';
import { attachWebSocketServer } from '../../backend/src/transports/wsServer.js';
import { startChroma, type ChromaServer } from './chroma.js';
import { geminiApiKey, pacedGemini } from './gemini.js';
import { listen, type RunningServer } from './http.js';
import { testConfig } from './testApp.js';

const backendDir = resolve(import.meta.dir, '../../backend');

export interface LiveHarness {
  deps: Dependencies;
  chroma: ChromaServer;
  server: RunningServer;
  prisma: PrismaClient;
  vectorStore: ChromaVectorStoreAdapter;
  close(): Promise<void>;
}

export interface LiveOptions {
  name: string;
  env?: Record<string, string>;
  modelProvider?: ChatModelProvider;
  searchProvider?: SearchProvider;
  scraper?: Scraper;
}

/** The whole backend on REAL infrastructure: Gemini (paced), a disk-backed Chroma server, SQLite via Prisma. */
export async function startLiveApp(opts: LiveOptions): Promise<LiveHarness> {
  const chroma = await startChroma(opts.name);
  const dir = mkdtempSync(join(tmpdir(), `live-${opts.name}-`));
  const dbUrl = `file:${join(dir, 'app.db')}`;
  execFileSync('bunx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], { cwd: backendDir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' });
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  const embeddings = new GeminiEmbeddingProvider({ apiKey: geminiApiKey });
  const vectorStore = new ChromaVectorStoreAdapter({
    collectionName: `live_${opts.name}_${Date.now()}`,
    url: chroma.url,
    embeddings,
    metadata: embeddings.metadata,
    breaker: new CircuitBreaker({ name: 'chroma-live', failureThreshold: 2, cooldownMs: 500 }),
    retry: { retries: 1, baseDelayMs: 100, maxDelayMs: 300 },
  });

  const config = testConfig({ VECTOR_STORE: 'chroma', CHROMA_URL: chroma.url, DATABASE_URL: dbUrl, GEMINI_API_KEY: geminiApiKey ?? '', INGEST_RETRY_BASE_MS: '1000', ...opts.env });
  const deps = buildDependencies(config, {
    storage: new PrismaStorageAdapter(prisma),
    modelProvider: opts.modelProvider ?? pacedGemini(),
    embeddings,
    vectorStore,
    searchProvider: opts.searchProvider ?? new DuckDuckGoSearchProvider(),
    scraper: opts.scraper ?? new HttpScraper(),
    logger: createLogger('silent'),
  });
  const server = await listen(createApp(deps));
  const wss = attachWebSocketServer(server.server, deps);

  return {
    deps, chroma, server, prisma, vectorStore,
    close: async () => {
      wss.clients.forEach((c) => c.terminate());
      wss.close();
      await server.close();
      await prisma.$disconnect();
      await chroma.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A real SQLite database (fresh schema) for tests that need the Prisma layer but not Chroma/Gemini. */
export async function tempPrismaStorage(): Promise<{ storage: PrismaStorageAdapter; prisma: PrismaClient; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'prisma-sec-'));
  const dbUrl = `file:${join(dir, 'sec.db')}`;
  execFileSync('bunx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], { cwd: backendDir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' });
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  return { storage: new PrismaStorageAdapter(prisma), prisma, cleanup: async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); } };
}
