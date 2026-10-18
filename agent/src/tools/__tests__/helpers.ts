import { parseAgentContext, type AgentContextInput } from '../../context.js';

export function ctx(overrides: Partial<AgentContextInput> = {}) {
  return parseAgentContext({
    principalId: 'alice',
    tenantId: 'alice',
    scopes: ['kb:read', 'kb:write', 'web'],
    executionId: 'exec-1',
    budget: { maxToolCalls: 5, maxModelCalls: 5 },
    ...overrides,
  });
}
