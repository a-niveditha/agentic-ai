import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { AgentContext } from '../context.js';
import { classifyError, friendlyMessage } from '../resilience/errors.js';
import type { Citation } from '../rag/types.js';
import { isAuthorized } from './policy.js';
import { BUDGET_EXHAUSTED_MESSAGE } from './budget.js';
import type { BuildOptions, RegisteredTool, ToolAuthPolicy } from './types.js';

/** An error whose message is safe to show to the model and the end user. */
export class ToolUserError extends Error {
  constructor(message: string, public readonly retryable = false) {
    super(message);
    this.name = 'ToolUserError';
  }
}

export interface ToolOutput {
  /** Structured result (returned to API clients / tests). */
  data: unknown;
  /** Text the model sees. Defaults to JSON.stringify(data). Fence untrusted content with fenceUntrusted(). */
  text?: string;
  citations?: Citation[];
}

export interface ToolEnvelope {
  ok: boolean;
  content: string;
  data?: unknown;
  citations: Citation[];
  error?: { reason: string; retryable: boolean };
}

/**
 * Template for a tool. Subclass it, define `name`, `description`, a zod `schema` and `run()`.
 * The base class guarantees: input validation, scope authorization, cancellation, and that failures come
 * back as a structured result the model can reason about, never as an exception that kills the run.
 * Tenant identity comes ONLY from the trusted `context`, never from model-supplied arguments.
 */
export abstract class BaseAgentTool<S extends z.ZodObject<any> = z.ZodObject<any>> implements RegisteredTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly schema: S;
  readonly authPolicy: ToolAuthPolicy = {};

  protected abstract run(input: z.infer<S>, context: AgentContext, signal?: AbortSignal): Promise<ToolOutput>;

  async execute(rawInput: unknown, context: AgentContext, signal?: AbortSignal): Promise<ToolEnvelope> {
    const fail = (reason: string, retryable = false): ToolEnvelope => ({
      ok: false,
      content: `ERROR: ${reason}${retryable ? ' (this may work if retried later)' : ''}`,
      citations: [],
      error: { reason, retryable },
    });

    if (!isAuthorized(this.authPolicy, context)) return fail(`You are not permitted to use the '${this.name}' tool.`);
    if (signal?.aborted) return fail('The request was cancelled.');

    const parsed = this.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return fail(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
    }

    try {
      const out = await this.run(parsed.data, context, signal);
      return {
        ok: true,
        content: out.text ?? safeStringify(out.data),
        data: out.data,
        citations: out.citations ?? [],
      };
    } catch (err) {
      if (err instanceof ToolUserError) return fail(err.message, err.retryable);
      const c = classifyError(err);
      if (c.kind === 'aborted') return fail('The request was cancelled.');
      if (c.kind !== 'unknown') return fail(friendlyMessage(c.kind, `The '${this.name}' tool's backing service`), c.retryable);
      return fail(`The '${this.name}' tool failed unexpectedly.`);
    }
  }

  build(context: AgentContext, options: BuildOptions = {}): StructuredToolInterface {
    return new DynamicStructuredTool({
      name: this.name,
      description: this.description,
      schema: this.schema,
      responseFormat: 'content_and_artifact',
      func: async (input: unknown, _runManager, config) => {
        if (options.budget && !options.budget.tryConsume()) {
          return [BUDGET_EXHAUSTED_MESSAGE, { ok: false, citations: [], error: { reason: 'tool budget exhausted', retryable: false } }];
        }
        const result = await this.execute(input, context, config?.signal ?? options.signal);
        return [result.content, { ok: result.ok, citations: result.citations, data: result.data, error: result.error }];
      },
    }) as unknown as StructuredToolInterface;
  }
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data) ?? 'null';
  } catch {
    return String(data);
  }
}
