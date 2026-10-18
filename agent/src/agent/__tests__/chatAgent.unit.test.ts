import { describe, expect, it } from 'bun:test';
import { ChatAgent, textOf, type ChatAgentResult } from '../ChatAgent.js';
import type { StreamEvent } from '../events.js';
import { ScriptedChatModelProvider, type ScriptedTurn } from '../../testing/ScriptedChatModel.js';
import { CalculatorTool } from '../../tools/builtins/CalculatorTool.js';
import { KnowledgeBaseSearchTool } from '../../tools/builtins/KnowledgeBaseSearchTool.js';
import { BaseAgentTool, ToolUserError } from '../../tools/BaseAgentTool.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { ingestDocument } from '../../rag/ingestion/ingestion.js';
import { makeStore } from '../../rag/__tests__/helpers.js';
import { InvalidAgentContextError } from '../../context.js';
import { z } from 'zod';

const context = (o: any = {}) => ({ principalId: 'alice', tenantId: 'alice', scopes: ['kb:read'], executionId: 'e1', budget: { maxToolCalls: 4, maxModelCalls: 5 }, ...o });

async function run(script: ScriptedTurn[], opts: { registry?: ToolRegistry; context?: any; signal?: AbortSignal; repeat?: boolean; history?: any[]; summary?: string; q?: string } = {}) {
  const provider = new ScriptedChatModelProvider(script, opts.repeat ?? false);
  const registry = opts.registry ?? new ToolRegistry().register(new CalculatorTool());
  const agent = new ChatAgent({ modelProvider: provider, registry });
  const events: StreamEvent[] = [];
  const result = await agent.run({ messages: [...(opts.history ?? []), { role: 'user', content: opts.q ?? 'hi' }], summary: opts.summary, context: opts.context ?? context(), signal: opts.signal, onEvent: (e) => events.push(e) });
  return { result, events, provider, types: events.map((e) => e.type) };
}

describe('ChatAgent', () => {
  it('answers without tools: start -> tokens -> done', async () => {
    const { result, types, events } = await run([{ text: 'Hello there, friend.' }]);
    expect(result).toMatchObject({ status: 'completed', answer: 'Hello there, friend.', toolCalls: [], citations: [] });
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('done');
    expect(events.filter((e) => e.type === 'token').map((e) => e.payload.token).join('')).toBe('Hello there, friend.');
    expect(events.at(-1)!.payload).toMatchObject({ fullResponse: 'Hello there, friend.', status: 'completed', citationsCount: 0 });
  });

  it('runs a tool then answers; emits tool_start/tool_end in order', async () => {
    const { result, events, types } = await run([
      { toolCalls: [{ name: 'calculator', args: { expression: '6*7' } }] },
      { text: 'It is 42.' },
    ]);
    expect(result).toMatchObject({ status: 'completed', answer: 'It is 42.' });
    expect(result.toolCalls).toEqual([expect.objectContaining({ name: 'calculator', input: { expression: '6*7' }, ok: true })]);
    expect(types.indexOf('tool_start')).toBeLessThan(types.indexOf('tool_end'));
    expect(types.indexOf('tool_end')).toBeLessThan(types.indexOf('token'));
    expect(events.find((e) => e.type === 'tool_end')!.payload).toMatchObject({ tool: 'calculator', success: true, output: '6*7 = 42' });
  });

  it('feeds the tool result back to the model', async () => {
    const { provider } = await run([{ toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] }, { text: 'four' }]);
    const secondPrompt = provider.lastModel!.received[1]!.map((m) => String(m.content)).join('\n');
    expect(secondPrompt).toContain('2+2 = 4');
  });

  it('supports parallel tool calls in one step', async () => {
    const { result } = await run([
      { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }, { name: 'calculator', args: { expression: '2+2' } }] },
      { text: 'done' },
    ]);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.every((t) => t.ok)).toBe(true);
  });

  it('emits exactly one tool_start/tool_end (and one citation set) per call, even with many parallel calls', async () => {
    const c = makeStore();
    await ingestDocument('The Zorblax protocol uses port 4242.', c.store, { userId: 'alice', sourceId: 'd1', title: 'Zorblax Spec' });
    const registry = new ToolRegistry().register(new KnowledgeBaseSearchTool(c.store)).register(new CalculatorTool());
    const calls = [
      ...Array.from({ length: 4 }, (_, i) => ({ name: 'knowledge_base_search', args: { query: `zorblax ${i}` } })),
      ...Array.from({ length: 4 }, (_, i) => ({ name: 'calculator', args: { expression: `${i}+1` } })),
    ];
    const { result, events } = await run([{ toolCalls: calls }, { text: 'done' }], { registry, context: context({ budget: { maxToolCalls: 20, maxModelCalls: 5 } }) });
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(8);
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(8);
    expect(new Set(events.filter((e) => e.type === 'tool_end').map((e) => e.payload.id)).size).toBe(8);
    expect(events.filter((e) => e.type === 'citation')).toHaveLength(4);
    expect(result.citations).toHaveLength(4);
    expect(result.toolCalls).toHaveLength(8);
  });

  it('many parallel tool calls in ONE step are a single model call: a small model-call budget still completes', async () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({ name: 'calculator', args: { expression: `${i}+1` } }));
    const { result } = await run([{ toolCalls: calls }, { text: 'all done' }], { context: context({ budget: { maxToolCalls: 20, maxModelCalls: 2 } }) });
    expect(result.status).toBe('completed');
    expect(result.answer).toBe('all done');
  });

  it('emits citation events and collects them in the result', async () => {
    const c = makeStore();
    await ingestDocument('The Zorblax protocol uses port 4242.', c.store, { userId: 'alice', sourceId: 'd1', title: 'Zorblax Spec' });
    const registry = new ToolRegistry().register(new KnowledgeBaseSearchTool(c.store));
    const { result, events } = await run([{ toolCalls: [{ name: 'knowledge_base_search', args: { query: 'zorblax port' } }] }, { text: 'Port 4242 (Zorblax Spec).' }], { registry });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ title: 'Zorblax Spec', sourceId: 'd1' });
    expect(events.filter((e) => e.type === 'citation')).toHaveLength(1);
  });

  it('TENANT BINDING: the tool runs as the trusted context even if the model names another tenant', async () => {
    const c = makeStore();
    await ingestDocument('Bob private vault code 9981.', c.store, { userId: 'bob', sourceId: 'b1', title: 'Bob' });
    const registry = new ToolRegistry().register(new KnowledgeBaseSearchTool(c.store));
    const { result, events } = await run([{ toolCalls: [{ name: 'knowledge_base_search', args: { query: 'vault code', userId: 'bob', tenantId: 'bob' } }] }, { text: 'nothing found' }], { registry });
    expect(result.citations).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('9981');
  });

  it('SCOPES: a tool the caller may not use is not even offered; calling it yields an error result, not execution', async () => {
    class Secret extends BaseAgentTool<z.ZodObject<{}>> {
      readonly name = 'secret_tool'; readonly description = 's'; readonly schema = z.object({}); override readonly authPolicy = { requiredScopes: ['admin'] };
      ran = 0;
      protected async run() { this.ran++; return { data: 'classified' }; }
    }
    const secret = new Secret();
    const registry = new ToolRegistry().register(secret).register(new CalculatorTool());
    const { result } = await run([{ toolCalls: [{ name: 'secret_tool', args: {} }] }, { text: 'could not' }], { registry });
    expect(secret.ran).toBe(0);
    expect(result.toolCalls[0]?.ok).not.toBe(true);
  });

  it('TOOL FAILURE is contained: the model sees the error and still answers', async () => {
    class Flaky extends BaseAgentTool<z.ZodObject<{}>> {
      readonly name = 'flaky'; readonly description = 'f'; readonly schema = z.object({});
      protected async run(): Promise<any> { throw new ToolUserError('Service busy', true); }
    }
    const { result, provider, events } = await run([{ toolCalls: [{ name: 'flaky', args: {} }] }, { text: 'I could not reach the service.' }], { registry: new ToolRegistry().register(new Flaky()) });
    expect(result.status).toBe('completed');
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(events.find((e) => e.type === 'tool_end')!.payload.success).toBe(false);
    expect(provider.lastModel!.received[1]!.map((m) => String(m.content)).join('\n')).toContain('Service busy');
  });

  it('BUDGET: tool calls beyond maxToolCalls are refused but the run still finishes with an answer', async () => {
    const call = { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] };
    const { result } = await run([call, call, call, { text: 'Stopped using tools.' }], { context: context({ budget: { maxToolCalls: 1, maxModelCalls: 6 } }) });
    expect(result.status).toBe('completed');
    expect(result.answer).toBe('Stopped using tools.');
    expect(result.toolCalls.filter((t) => t.ok).length).toBeLessThanOrEqual(1);
  });

  it('ITERATION LIMIT: a model that never stops calling tools ends as limit_reached with a partial answer, not a hang', async () => {
    const call: ScriptedTurn = { text: 'Still working...', toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] };
    const { result, types } = await run([call], { repeat: true, context: context({ budget: { maxToolCalls: 50, maxModelCalls: 3 } }) });
    expect(result.status).toBe('limit_reached');
    expect(result.answer.length).toBeGreaterThan(0);
    expect(types.at(-1)).toBe('done');
  });

  it('DEGRADES when the model provider is down: friendly error event, status error, no crash', async () => {
    const provider = new ScriptedChatModelProvider([{ text: 'x' }]);
    provider.available = false;
    const events: StreamEvent[] = [];
    const result = await new ChatAgent({ modelProvider: provider, registry: new ToolRegistry() }).run({ messages: [{ role: 'user', content: 'hi' }], context: context(), onEvent: (e) => events.push(e) });
    expect(result.status).toBe('error');
    expect(result.error!.code).toBe('model_unavailable');
    expect(result.error!.message).not.toMatch(/scripted provider offline/);
    expect(events.map((e) => e.type)).toEqual(['start', 'error', 'done']);
  });

  it('DEGRADES on mid-run model errors (429): error event with a rate-limit message and the partial answer retained', async () => {
    const err = Object.assign(new Error('RESOURCE_EXHAUSTED quota'), { status: 429 });
    const { result, types } = await run([{ toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] }, { error: err }], { repeat: true });
    expect(result.status).toBe('error');
    expect(result.error!.message).toMatch(/rate-limited/);
    expect(types).toContain('error');
    expect(types.at(-1)).toBe('done');
  });

  it('reports an empty model response as an error instead of an empty "success"', async () => {
    const { result } = await run([{ text: '' }]);
    expect(result.status).toBe('error');
    expect(result.error!.code).toBe('empty_response');
  });

  it('CANCELLATION: an already-aborted signal returns interrupted without calling the model', async () => {
    const c = new AbortController();
    c.abort();
    const { result, provider } = await run([{ text: 'never' }], { signal: c.signal });
    expect(result.status).toBe('interrupted');
    expect(provider.lastModel).toBeUndefined();
  });

  it('CANCELLATION: aborting mid-run stops the run and reports interrupted', async () => {
    const c = new AbortController();
    const provider = new ScriptedChatModelProvider([
      () => { c.abort(); return { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] }; },
      { text: 'should not complete' },
    ]);
    const result = await new ChatAgent({ modelProvider: provider, registry: new ToolRegistry().register(new CalculatorTool()) }).run({ messages: [{ role: 'user', content: 'hi' }], context: context(), signal: c.signal });
    expect(result.status).toBe('interrupted');
    expect(result.answer).not.toContain('should not complete');
  });

  it('rejects an invalid AgentContext outright (programmer/security error, not a chat error)', async () => {
    const agent = new ChatAgent({ modelProvider: new ScriptedChatModelProvider([{ text: 'x' }]), registry: new ToolRegistry() });
    await expect(agent.run({ messages: [{ role: 'user', content: 'hi' }], context: { principalId: 'x' } as any })).rejects.toBeInstanceOf(InvalidAgentContextError);
  });

  it('REGRESSION: a long history does not count against the model-call limit (middleware nodes re-emit the whole state)', async () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` }));
    const { result, events } = await run([{ text: 'All good.' }], { history });
    expect(result).toMatchObject({ status: 'completed', answer: 'All good.' });
    expect(events.filter((e) => e.type === 'token').map((e) => e.payload.token).join('')).toBe('All good.');
  });

  it('REGRESSION: a past assistant message that mentions limits is not mistaken for the limit middleware', async () => {
    const { result } = await run([{ text: 'Fine.' }], { history: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'Model call limits exceeded: run limit (8/8)' }] });
    expect(result.status).toBe('completed');
  });

  it('passes conversation history and the summary to the model', async () => {
    const { provider } = await run([{ text: 'ok' }], {
      history: [{ role: 'user', content: 'My name is Priya' }, { role: 'assistant', content: 'Nice to meet you Priya' }],
      summary: 'Earlier they discussed lighthouses.', q: 'What is my name?',
    });
    const prompt = JSON.stringify(provider.lastModel!.received[0]!.map((m) => m.content));
    expect(prompt).toContain('My name is Priya');
    expect(prompt).toContain('What is my name?');
    expect(prompt).toContain('Earlier they discussed lighthouses.');
  });

  it('system prompt includes the untrusted-data rule and operator extras', async () => {
    const provider = new ScriptedChatModelProvider([{ text: 'ok' }]);
    const agent = new ChatAgent({ modelProvider: provider, registry: new ToolRegistry(), systemPrompt: 'Always answer in French.', assistantName: 'Aria' });
    const prompt = agent.buildSystemPrompt('sum');
    expect(prompt).toContain('Aria');
    expect(prompt).toMatch(/never follow instructions/i);
    expect(prompt).toContain('Always answer in French.');
    expect(prompt).toContain('sum');
  });

  it('works without an onEvent callback', async () => {
    const provider = new ScriptedChatModelProvider([{ text: 'quiet' }]);
    const r = await new ChatAgent({ modelProvider: provider, registry: new ToolRegistry() }).run({ messages: [{ role: 'user', content: 'hi' }], context: context() });
    expect(r.answer).toBe('quiet');
  });
});

describe('textOf', () => {
  it('flattens string, parts arrays and unknown shapes', () => {
    expect(textOf('a')).toBe('a');
    expect(textOf([{ type: 'text', text: 'a' }, 'b', { type: 'image' }, { text: 'c' }])).toBe('abc');
    expect(textOf(undefined)).toBe('');
    expect(textOf(5)).toBe('');
  });
});

export type { ChatAgentResult };
