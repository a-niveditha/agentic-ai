import { z } from 'zod';

/**
 * Trusted execution identity. Built by the host application from verified credentials (never from
 * model output or request bodies) and bound to the tools of a single run.
 */
export const AgentContextSchema = z.object({
  principalId: z.string().min(1),
  tenantId: z.string().min(1),
  scopes: z.array(z.string()),
  executionId: z.string().min(1),
  budget: z.object({
    maxToolCalls: z.number().int().nonnegative(),
    maxModelCalls: z.number().int().positive().default(8),
    maxTokens: z.number().int().positive().optional(),
  }),
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
export type AgentContextInput = z.input<typeof AgentContextSchema>;

export class InvalidAgentContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentContextError';
  }
}

/** Validates and normalizes a context, throwing InvalidAgentContextError when it is malformed. */
export function parseAgentContext(input: unknown): AgentContext {
  const result = AgentContextSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidAgentContextError(
      `Invalid AgentContext: ${result.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
    );
  }
  return Object.freeze({ ...result.data, scopes: Object.freeze([...result.data.scopes]) as string[] });
}

export function isAgentContext(input: unknown): input is AgentContext {
  return AgentContextSchema.safeParse(input).success;
}
