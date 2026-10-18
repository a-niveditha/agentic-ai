import {
  CalculatorTool,
  ChatAgent,
  ChatModelProvider,
  ChromaVectorStoreAdapter,
  DuckDuckGoSearchProvider,
  EmbeddingProvider,
  GeminiChatModelProvider,
  GeminiEmbeddingProvider,
  HealthCheckable,
  HttpScraper,
  InMemoryVectorStoreAdapter,
  KnowledgeBaseSearchTool,
  LoaderRegistry,
  McpToolSource,
  SaveToKnowledgeBaseTool,
  Scraper,
  SearchProvider,
  StandaloneRagChain,
  ToolRegistry,
  VectorStoreAdapter,
  WebScrapeTool,
  WebSearchTool,
  createDefaultLoaderRegistry,
  createEmbeddingProvider,
  loadMcpConfig,
} from '@agentic-ai/agent';
import type { AppConfig } from './config/env.js';
import { TokenService, type TicketStore } from './lib/tokens.js';
import { createLogger, type Logger } from './lib/logger.js';
import { PrismaStorageAdapter } from './services/PrismaStorageAdapter.js';
import type { AbstractStorageAdapter } from './services/AbstractStorageAdapter.js';
import { ChatService } from './services/chatService.js';
import { DocumentService } from './services/documentService.js';

export interface Dependencies {
  config: AppConfig;
  logger: Logger;
  storage: AbstractStorageAdapter;
  tokens: TokenService;
  modelProvider: ChatModelProvider;
  embeddings: EmbeddingProvider;
  vectorStore: VectorStoreAdapter;
  searchProvider: SearchProvider;
  scraper: Scraper;
  loaders: LoaderRegistry;
  mcp?: McpToolSource;
  registry: ToolRegistry;
  agent: ChatAgent;
  chat: ChatService;
  documents: DocumentService;
  rag: StandaloneRagChain;
  /** Everything /api/v1/ready reports on. */
  healthComponents: HealthCheckable[];
}

/** Test seams: any piece can be replaced (fake LLM, in-memory store...). Production passes nothing. */
export type DependencyOverrides = Partial<
  Pick<Dependencies, 'storage' | 'modelProvider' | 'embeddings' | 'vectorStore' | 'searchProvider' | 'scraper' | 'loaders' | 'logger' | 'mcp'>
> & { ticketStore?: TicketStore };

export function buildDependencies(config: AppConfig, overrides: DependencyOverrides = {}): Dependencies {
  const logger = overrides.logger ?? createLogger(config.LOG_LEVEL);
  const storage = overrides.storage ?? new PrismaStorageAdapter();
  const tokens = new TokenService(
    { secret: config.JWT_SECRET, accessTtl: config.ACCESS_TOKEN_TTL, ticketTtlSeconds: config.STREAM_TICKET_TTL_SECONDS },
    overrides.ticketStore,
  );

  const modelProvider = overrides.modelProvider ?? new GeminiChatModelProvider({ apiKey: config.geminiApiKey, model: config.GEMINI_MODEL, maxRetries: config.GEMINI_MAX_RETRIES });
  const embeddings = overrides.embeddings ?? createEmbeddingProvider({ provider: config.EMBEDDING_PROVIDER, apiKey: config.geminiApiKey });
  const vectorStore =
    overrides.vectorStore ??
    (config.VECTOR_STORE === 'memory'
      ? new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata })
      : new ChromaVectorStoreAdapter({ collectionName: config.CHROMA_COLLECTION, url: config.CHROMA_URL, embeddings, metadata: embeddings.metadata }));

  const searchProvider = overrides.searchProvider ?? new DuckDuckGoSearchProvider();
  const scraper = overrides.scraper ?? new HttpScraper();
  const loaders = overrides.loaders ?? createDefaultLoaderRegistry({ maxBytes: config.MAX_UPLOAD_MB * 1024 * 1024 });
  const mcp = overrides.mcp ?? (config.MCP_CONFIG_PATH ? new McpToolSource(loadMcpConfig(config.MCP_CONFIG_PATH)) : undefined);

  const documents = new DocumentService({
    storage,
    vectorStore,
    loaders,
    scraper,
    logger,
    limits: { maxDocsPerUser: config.MAX_DOCS_PER_USER },
    ingestion: {
      concurrency: config.INGEST_CONCURRENCY,
      maxQueued: config.INGEST_MAX_QUEUED,
      embedBatchSize: config.EMBED_BATCH_SIZE,
      minBatchIntervalMs: config.EMBED_BATCH_INTERVAL_MS,
      maxAttempts: config.INGEST_MAX_ATTEMPTS,
      retryBaseDelayMs: config.INGEST_RETRY_BASE_MS,
    },
  });

  const registry = new ToolRegistry()
    .register(new CalculatorTool())
    .register(new KnowledgeBaseSearchTool(vectorStore))
    .register(new WebSearchTool(searchProvider))
    .register(new WebScrapeTool(scraper))
    .register(new SaveToKnowledgeBaseTool(scraper, documents));
  if (mcp) registry.addSource(mcp);

  const agent = new ChatAgent({ modelProvider, registry });
  const chat = new ChatService({
    storage,
    agent,
    modelProvider,
    vectorStore,
    logger,
    scopes: config.defaultScopes,
    limits: { maxToolCalls: config.MAX_TOOL_CALLS_PER_TURN, maxModelCalls: config.MAX_MODEL_CALLS_PER_TURN },
  });
  const rag = new StandaloneRagChain({ store: vectorStore, modelProvider });

  const healthComponents: HealthCheckable[] = [storage, modelProvider, embeddings, vectorStore, searchProvider, scraper, registry];

  return { config, logger, storage, tokens, modelProvider, embeddings, vectorStore, searchProvider, scraper, loaders, mcp, registry, agent, chat, documents, rag, healthComponents };
}
