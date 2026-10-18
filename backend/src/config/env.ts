import { z } from 'zod';

/** Secrets that have shipped in this repo's examples/history and must never protect a real deployment. */
export const KNOWN_WEAK_JWT_SECRETS = ['super-secret-agentic-ai-jwt-token-key-2026', 'changeme', 'secret'];

const csv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(5000),
  DATABASE_URL: z.string().min(1).default('file:./dev.db'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be set to a random string of at least 16 characters'),
  ACCESS_TOKEN_TTL: z.string().default('7d'),
  STREAM_TICKET_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(60),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  ENABLE_DOCS: z.enum(['true', 'false']).optional(),

  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  EMBEDDING_PROVIDER: z.enum(['gemini', 'local']).default('gemini'),

  VECTOR_STORE: z.enum(['chroma', 'memory']).default('chroma'),
  CHROMA_URL: z.string().default('http://localhost:8000'),
  CHROMA_COLLECTION: z.string().default('agentic_ai_kb'),

  MCP_CONFIG_PATH: z.string().optional(),
  DEFAULT_USER_SCOPES: z.string().default('kb:read,kb:write,web'),

  MAX_UPLOAD_MB: z.coerce.number().positive().max(100).default(10),
  MAX_DOCS_PER_USER: z.coerce.number().int().positive().default(200),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(4000),
  INGEST_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  INGEST_MAX_QUEUED: z.coerce.number().int().min(1).default(500),
  INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  INGEST_RETRY_BASE_MS: z.coerce.number().int().min(1).default(2000),
  EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(32),
  EMBED_BATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().min(0).default(6),
  MAX_MODEL_CALLS_PER_TURN: z.coerce.number().int().min(1).default(8),

  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_DOCS_PER_MIN: z.coerce.number().int().positive().default(30),

  SSE_HEARTBEAT_MS: z.coerce.number().int().min(20).default(10_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppConfig extends Omit<RawEnv, 'CORS_ORIGINS' | 'DEFAULT_USER_SCOPES'> {
  geminiApiKey?: string;
  corsOrigins: string[];
  defaultScopes: string[];
  docsEnabled: boolean;
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;
  const warnings: string[] = [];

  if (KNOWN_WEAK_JWT_SECRETS.includes(env.JWT_SECRET)) {
    const msg = 'JWT_SECRET is a publicly known example value; generate a new one (e.g. `openssl rand -base64 48`).';
    if (env.NODE_ENV === 'production') throw new ConfigError(msg);
    warnings.push(msg);
  }
  const geminiApiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined;
  if (!geminiApiKey) warnings.push('No GEMINI_API_KEY set: chat and embeddings run in degraded mode.');

  const corsOrigins = csv(env.CORS_ORIGINS);
  if (env.NODE_ENV === 'production' && corsOrigins.includes('*')) throw new ConfigError("CORS_ORIGINS must not be '*' in production.");

  return {
    ...env,
    geminiApiKey,
    corsOrigins,
    defaultScopes: csv(env.DEFAULT_USER_SCOPES),
    docsEnabled: env.ENABLE_DOCS ? env.ENABLE_DOCS === 'true' : env.NODE_ENV !== 'production',
    warnings,
  };
}
