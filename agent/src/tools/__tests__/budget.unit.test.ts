import { describe, expect, it } from 'bun:test';
import { ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { BaseAgentTool } from '../BaseAgentTool.js';
import { BUDGET_EXHAUSTED_MESSAGE, ToolBudget } from '../budget.js';
import { ctx } from './helpers.js';

describe('ToolBudget', () => {
  it('allows exactly `limit` executions', () => {
    const b = new ToolBudget(2);
    expect([b.tryConsume(), b.tryConsume(), b.tryConsume(), b.tryConsume()]).toEqual([true, true, false, false]);
    expect(b.used).toBe(2);
  });
  it('a zero budget refuses everything', () => {
    expect(new ToolBudget(0).tryConsume()).toBe(false);
  });
});

class Counter extends BaseAgentTool<z.ZodObject<{}>> {
  readonly name = 'counter'; readonly description = 'c'; readonly schema = z.object({});
  runs = 0;
  protected async run() { this.runs++; return { data: this.runs }; }
}

describe('budget enforcement in built tools', () => {
  it('stops executing after the limit and tells the model to answer with what it has', async () => {
    const tool = new Counter();
    const lc = tool.build(ctx(), { budget: new ToolBudget(2) });
    const call = (id: string) => lc.invoke({ name: 'counter', args: {}, id, type: 'tool_call' }) as Promise<ToolMessage>;
    expect((await call('1')).content).toBe('1');
    expect((await call('2')).content).toBe('2');
    const blocked = await call('3');
    expect(blocked.content).toBe(BUDGET_EXHAUSTED_MESSAGE);
    expect((blocked.artifact as any).ok).toBe(false);
    expect(tool.runs).toBe(2);
  });
  it('is shared across tools built with the same budget', async () => {
    const a = new Counter(); const b = new Counter();
    const budget = new ToolBudget(1);
    await a.build(ctx(), { budget }).invoke({ name: 'counter', args: {}, id: '1', type: 'tool_call' });
    const blocked = (await b.build(ctx(), { budget }).invoke({ name: 'counter', args: {}, id: '2', type: 'tool_call' })) as ToolMessage;
    expect(blocked.content).toBe(BUDGET_EXHAUSTED_MESSAGE);
    expect(b.runs).toBe(0);
  });
});
