import { FakeEmbeddingProvider, InMemoryVectorStoreAdapter, ScriptedChatModelProvider, type ScriptedTurn, type Scraper, type SearchProvider, type ScrapedPage } from '../../agent/src/index.js';
import { createApp } from '../../backend/src/app.js';
import { loadConfig, type AppConfig } from '../../backend/src/config/env.js';
import { buildDependencies, type Dependencies, type DependencyOverrides } from '../../backend/src/container.js';
import { createLogger } from '../../backend/src/lib/logger.js';
import { InMemoryStorageAdapter } from '../../backend/src/services/InMemoryStorageAdapter.js';
import { attachWebSocketServer } from '../../backend/src/transports/wsServer.js';
import { listen, type RunningServer } from './http.js';

export const TEST_JWT_SECRET = 'unit-test-secret-0123456789-abcdefghij';

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: TEST_JWT_SECRET,
    GEMINI_API_KEY: 'test-key',
    VECTOR_STORE: 'memory',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_AUTH_PER_MIN: '1000',
    RATE_LIMIT_CHAT_PER_MIN: '1000',
    RATE_LIMIT_DOCS_PER_MIN: '1000',
    INGEST_RETRY_BASE_MS: '5',
    ...env,
  });
}

export class FakeSearchProvider implements SearchProvider {
  readonly name = 'fake-search';
  readonly componentName = 'search:fake';
  calls: string[] = [];
  fail?: Error;
  results = [{ title: 'Example Result', url: 'https://example.com/page', snippet: 'An example snippet about widgets.' }];
  async search(query: string) {
    this.calls.push(query);
    if (this.fail) throw this.fail;
    return this.results;
  }
  async checkHealth() {
    return { status: (this.fail ? 'down' : 'up') as 'up' | 'down', checkedAt: Date.now() };
  }
}

export class FakeScraper implements Scraper {
  readonly componentName = 'scraper:fake';
  calls: string[] = [];
  fail?: Error;
  pages = new Map<string, Partial<ScrapedPage>>();
  async scrape(url: string): Promise<ScrapedPage> {
    this.calls.push(url);
    if (this.fail) throw this.fail;
    const p = this.pages.get(url);
    return { url, title: 'Fake Page', markdown: 'Fake page content about widgets and gadgets, long enough to be saved.', contentType: 'text/html', bytesRead: 100, truncated: false, ...p };
  }
  async checkHealth() {
    return { status: 'up' as const, checkedAt: Date.now() };
  }
}

export interface TestHarness {
  deps: Dependencies;
  storage: InMemoryStorageAdapter;
  model: ScriptedChatModelProvider;
  embeddings: FakeEmbeddingProvider;
  search: FakeSearchProvider;
  scraper: FakeScraper;
  server: RunningServer;
  close(): Promise<void>;
}

/** The full backend wired to deterministic fakes (no network, no disk), listening on an ephemeral port. */
export async function startTestApp(opts: { script?: ScriptedTurn[]; repeatLast?: boolean; env?: Record<string, string>; overrides?: DependencyOverrides } = {}): Promise<TestHarness> {
  const storage = new InMemoryStorageAdapter();
  const embeddings = new FakeEmbeddingProvider();
  const model = new ScriptedChatModelProvider(opts.script ?? [{ text: 'Hello from the scripted model.' }], opts.repeatLast ?? true);
  const search = new FakeSearchProvider();
  const scraper = new FakeScraper();
  const config = testConfig(opts.env);
  const deps = buildDependencies(config, {
    storage,
    modelProvider: model,
    embeddings,
    vectorStore: new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata }),
    searchProvider: search,
    scraper,
    logger: createLogger('silent'),
    ...opts.overrides,
  });
  const app = createApp(deps);
  const server = await listen(app);
  const wss = attachWebSocketServer(server.server, deps);
  return {
    deps, storage, model, embeddings, search, scraper, server,
    close: async () => {
      wss.clients.forEach((c) => c.terminate());
      wss.close();
      await server.close();
    },
  };
}
