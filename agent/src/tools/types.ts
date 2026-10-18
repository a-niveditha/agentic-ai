import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentContext } from '../context.js';
import type { HealthCheckable } from '../resilience/health.js';
import type { ToolBudget } from './budget.js';

export interface BuildOptions {
  signal?: AbortSignal;
  /** Shared per-run cap on tool executions. */
  budget?: ToolBudget;
}

export interface ToolAuthPolicy {
  /** Every listed scope must be present in the caller's AgentContext. */
  requiredScopes?: string[];
}

/** Anything the registry can hand to an agent. Built-in tools, MCP tools and your own all implement this. */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly authPolicy: ToolAuthPolicy;
  /** Create the LangChain tool bound to one trusted execution context. */
  build(context: AgentContext, options?: BuildOptions): StructuredToolInterface;
}

/** A dynamic collection of tools (e.g. an MCP server) whose membership can change at runtime. */
export interface ToolSource extends HealthCheckable {
  listTools(): RegisteredTool[];
}
