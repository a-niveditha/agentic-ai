import { describe, expect, it } from 'bun:test';
import { InvalidAgentContextError, isAgentContext, parseAgentContext } from '../context.js';

const valid = { principalId: 'u1', tenantId: 't1', scopes: ['kb:read'], executionId: 'e1', budget: { maxToolCalls: 3 } };

describe('AgentContext', () => {
  it('parses a valid context and applies defaults', () => {
    const ctx = parseAgentContext(valid);
    expect(ctx.budget.maxModelCalls).toBe(8);
    expect(ctx.tenantId).toBe('t1');
  });

  it('returns a frozen context so tools cannot mutate identity', () => {
    const ctx = parseAgentContext(valid);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => { (ctx.scopes as string[]).push('admin'); }).toThrow();
  });

  it('rejects missing or empty identity fields', () => {
    for (const bad of [{ ...valid, principalId: '' }, { ...valid, tenantId: undefined }, { ...valid, executionId: '' }, { ...valid, scopes: 'kb:read' }, { ...valid, budget: { maxToolCalls: -1 } }, null, 'str', {}]) {
      expect(() => parseAgentContext(bad)).toThrow(InvalidAgentContextError);
      expect(isAgentContext(bad)).toBe(false);
    }
  });

  it('error message names the offending fields', () => {
    expect(() => parseAgentContext({ ...valid, tenantId: '' })).toThrow(/tenantId/);
  });

  it('isAgentContext accepts valid input', () => {
    expect(isAgentContext(valid)).toBe(true);
  });
});
