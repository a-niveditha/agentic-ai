import type { AgentContext } from '../context.js';
import { isAgentContext } from '../context.js';
import type { ToolAuthPolicy } from './types.js';

/** Deny by default: an invalid context, or a missing required scope, means no access. */
export function isAuthorized(policy: ToolAuthPolicy, context: AgentContext | undefined): boolean {
  if (!context || !isAgentContext(context)) return false;
  const required = policy.requiredScopes ?? [];
  return required.every((scope) => context.scopes.includes(scope));
}
