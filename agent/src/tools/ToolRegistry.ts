import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentContext, isAgentContext } from '../context.js';
import { HealthCheckable, HealthReport, collectHealth, aggregateHealth, healthReport } from '../resilience/health.js';
import { isAuthorized } from './policy.js';
import type { BuildOptions, RegisteredTool, ToolSource } from './types.js';

/**
 * Holds every tool the application offers and resolves, per request, the subset a given caller may use.
 * Add your own tools with `register()`, or whole dynamic collections (MCP servers) with `addSource()`.
 */
export class ToolRegistry implements HealthCheckable {
  readonly componentName = 'tools';
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly sources: ToolSource[] = [];

  register(tool: RegisteredTool): this {
    if (this.all().some((t) => t.name === tool.name)) throw new Error(`A tool named '${tool.name}' is already registered.`);
    this.tools.set(tool.name, tool);
    return this;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  addSource(source: ToolSource): this {
    this.sources.push(source);
    return this;
  }

  /** Static tools first, then source tools; on a name clash the static tool wins. */
  all(): RegisteredTool[] {
    const merged = new Map(this.tools);
    for (const source of this.sources) {
      for (const tool of source.listTools()) if (!merged.has(tool.name)) merged.set(tool.name, tool);
    }
    return [...merged.values()];
  }

  /** Tools this context may use (deny by default for invalid contexts). */
  authorizedFor(context: AgentContext | undefined): RegisteredTool[] {
    if (!context || !isAgentContext(context)) return [];
    return this.all().filter((t) => isAuthorized(t.authPolicy, context));
  }

  getAuthorized(name: string, context: AgentContext | undefined): RegisteredTool | undefined {
    return this.authorizedFor(context).find((t) => t.name === name);
  }

  /** LangChain tools bound to this trusted context, ready to hand to an agent. */
  toolsFor(context: AgentContext, options?: BuildOptions): StructuredToolInterface[] {
    return this.authorizedFor(context).map((t) => t.build(context, options));
  }

  async checkHealth(): Promise<HealthReport> {
    const reports = await collectHealth(this.sources);
    const status = aggregateHealth(reports);
    const detail = `${this.all().length} tools registered` + (status === 'up' ? '' : `; sources: ${JSON.stringify(Object.fromEntries(Object.entries(reports).map(([k, v]) => [k, v.status])))}`);
    return healthReport(status === 'down' ? 'degraded' : status, detail);
  }
}
