import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { AgentContext } from '../context.js';
import { classifyError } from '../resilience/errors.js';
import { HealthReport, errorMessage, healthReport } from '../resilience/health.js';
import { fenceUntrusted } from '../rag/retrieval/untrusted.js';
import { BUDGET_EXHAUSTED_MESSAGE } from '../tools/budget.js';
import type { BuildOptions, RegisteredTool, ToolAuthPolicy, ToolSource } from '../tools/types.js';
import type { McpConfig, McpServerConfig } from './config.js';

export interface McpClientLike {
  listTools(): Promise<StructuredToolInterface[]>;
  close(): Promise<void>;
}
export type McpClientFactory = (serverName: string, config: McpServerConfig) => McpClientLike;

export interface McpToolSourceOptions {
  clientFactory?: McpClientFactory;
  connectTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  logger?: { warn(msg: string): void; info(msg: string): void };
}

type ServerState = {
  config: McpServerConfig;
  status: 'connecting' | 'up' | 'down';
  client?: McpClientLike;
  tools: McpRegisteredTool[];
  lastError?: string;
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
};

const defaultFactory: McpClientFactory = (name, cfg) => {
  const connection =
    cfg.transport === 'stdio'
      ? { transport: 'stdio' as const, command: cfg.command!, args: cfg.args, env: cfg.env }
      : { transport: 'http' as const, url: cfg.url!, headers: cfg.headers };
  return new MultiServerMCPClient({
    servers: { [name]: connection },
    prefixToolNameWithServerName: true,
    throwOnLoadError: true,
    onConnectionError: 'throw',
  } as any) as unknown as McpClientLike;
};

/** Wraps one MCP tool so that failures become tool errors and the output is fenced as untrusted data. */
class McpRegisteredTool implements RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly authPolicy: ToolAuthPolicy;

  constructor(
    private readonly inner: StructuredToolInterface,
    private readonly serverName: string,
    private readonly timeoutMs: number,
    requiredScopes: string[],
    private readonly onFailure: (serverName: string, err: unknown) => void,
  ) {
    this.name = inner.name;
    this.description = inner.description;
    this.authPolicy = { requiredScopes };
  }

  build(_context: AgentContext, options: BuildOptions = {}): StructuredToolInterface {
    const signal = options.signal;
    return new DynamicStructuredTool({
      name: this.name,
      description: this.description,
      schema: (this.inner as any).schema,
      responseFormat: 'content_and_artifact',
      func: async (input: unknown, _rm, config) => {
        if (options.budget && !options.budget.tryConsume()) return [BUDGET_EXHAUSTED_MESSAGE, { ok: false, citations: [] }];
        try {
          const out = await withTimeout(this.inner.invoke(input as any, { signal: config?.signal ?? signal }), this.timeoutMs, config?.signal ?? signal);
          const text = typeof out === 'string' ? out : JSON.stringify(out);
          return [fenceUntrusted(text, { tool: this.name, server: this.serverName }), { ok: true, citations: [] }];
        } catch (err) {
          if (classifyError(err).kind !== 'aborted') this.onFailure(this.serverName, err);
          return [`ERROR: The '${this.name}' tool failed (${classifyError(err).kind}). The external tool server may be unavailable.`, { ok: false, citations: [] }];
        }
      },
    }) as unknown as StructuredToolInterface;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms}ms`), { name: 'TimeoutError' })), ms);
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Tool source backed by external MCP servers. A server that is down never blocks startup or other servers:
 * its tools simply disappear until a background reconnect (exponential backoff) succeeds.
 */
export class McpToolSource implements ToolSource {
  readonly componentName = 'mcp';
  private readonly servers = new Map<string, ServerState>();
  private readonly factory: McpClientFactory;
  private readonly connectTimeoutMs: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly log: NonNullable<McpToolSourceOptions['logger']>;
  private stopped = false;

  constructor(config: McpConfig, options: McpToolSourceOptions = {}) {
    this.factory = options.clientFactory ?? defaultFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.baseMs = options.reconnectBaseMs ?? 2_000;
    this.maxMs = options.reconnectMaxMs ?? 60_000;
    this.log = options.logger ?? { warn: (m) => console.warn(m), info: () => {} };
    for (const [name, cfg] of Object.entries(config.servers)) {
      this.servers.set(name, { config: cfg, status: 'connecting', tools: [], attempts: 0 });
    }
  }

  /** Connects to every configured server in parallel. Never throws. */
  async start(): Promise<void> {
    await Promise.allSettled([...this.servers.keys()].map((name) => this.connect(name)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of this.servers.values()) {
      if (s.timer) clearTimeout(s.timer);
      await s.client?.close().catch(() => {});
    }
  }

  listTools(): RegisteredTool[] {
    return [...this.servers.values()].filter((s) => s.status === 'up').flatMap((s) => s.tools);
  }

  serverStatus(): Record<string, { status: ServerState['status']; tools: number; lastError?: string }> {
    return Object.fromEntries([...this.servers].map(([n, s]) => [n, { status: s.status, tools: s.tools.length, lastError: s.lastError }]));
  }

  private async connect(name: string): Promise<void> {
    const state = this.servers.get(name)!;
    if (this.stopped) return;
    state.status = 'connecting';
    await state.client?.close().catch(() => {});
    state.client = undefined;
    try {
      const client = this.factory(name, state.config);
      state.client = client;
      const tools = await withTimeout(client.listTools(), this.connectTimeoutMs);
      state.tools = tools.map((t) => new McpRegisteredTool(t, name, state.config.toolTimeoutMs, state.config.requiredScopes, (n, e) => this.markDown(n, e)));
      state.status = 'up';
      state.lastError = undefined;
      state.attempts = 0;
      this.log.info(`[mcp] '${name}' connected with ${tools.length} tools`);
    } catch (err) {
      await state.client?.close().catch(() => {});
      state.client = undefined;
      this.markDown(name, err);
    }
  }

  private markDown(name: string, err: unknown): void {
    const state = this.servers.get(name);
    if (!state || this.stopped || state.timer) return;
    const kind = classifyError(err).kind;
    // A live server only goes down on transport failures (closed pipe, reset). A slow tool, bad arguments or a
    // tool-level exception says nothing about the connection and must not tear it down.
    if (state.status === 'up' && kind !== 'network') return;
    state.status = 'down';
    state.tools = [];
    state.lastError = errorMessage(err).slice(0, 300);
    state.attempts += 1;
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** (state.attempts - 1));
    this.log.warn(`[mcp] '${name}' unavailable (${state.lastError}); retrying in ${delay}ms`);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.connect(name);
    }, delay);
    (state.timer as any).unref?.();
  }

  async checkHealth(): Promise<HealthReport> {
    const all = [...this.servers.values()];
    if (all.length === 0) return healthReport('up', 'no MCP servers configured');
    const down = all.filter((s) => s.status !== 'up');
    if (down.length === 0) return healthReport('up', `${all.length} server(s) connected`);
    return healthReport('degraded', `${down.length}/${all.length} MCP server(s) unavailable`);
  }
}

