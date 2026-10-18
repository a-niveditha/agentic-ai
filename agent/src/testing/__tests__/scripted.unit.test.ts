import { describe, expect, it } from 'bun:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ScriptedChatModel, ScriptedChatModelProvider } from '../ScriptedChatModel.js';

describe('ScriptedChatModel', () => {
  it('replays turns in order and records prompts', async () => {
    const m = new ScriptedChatModel([{ text: 'one' }, { text: 'two' }]);
    expect((await m.invoke([new HumanMessage('a')])).content).toBe('one');
    expect((await m.invoke([new HumanMessage('b')])).content).toBe('two');
    expect(m.received).toHaveLength(2);
    await expect(m.invoke([new HumanMessage('c')])).rejects.toThrow(/exhausted/);
  });
  it('repeats the last turn when asked', async () => {
    const m = new ScriptedChatModel([{ text: 'again' }], true);
    for (let i = 0; i < 3; i++) expect((await m.invoke([new HumanMessage('x')])).content).toBe('again');
  });
  it('emits tool calls and supports function turns and errors', async () => {
    const m = new ScriptedChatModel([{ toolCalls: [{ name: 't', args: { a: 1 } }] }, (msgs) => ({ text: `saw ${msgs.length}` }), { error: new Error('boom') }]);
    const first = (await m.invoke([new HumanMessage('x')])) as AIMessage;
    expect(first.tool_calls?.[0]).toMatchObject({ name: 't', args: { a: 1 } });
    expect((await m.invoke([new HumanMessage('x'), new HumanMessage('y')])).content).toBe('saw 2');
    await expect(m.invoke([new HumanMessage('z')])).rejects.toThrow('boom');
  });
  it('streams word by word', async () => {
    const m = new ScriptedChatModel([{ text: 'a b c' }]);
    const parts: string[] = [];
    for await (const chunk of await m.stream([new HumanMessage('x')])) parts.push(String(chunk.content));
    expect(parts.join('')).toBe('a b c');
    expect(parts.length).toBeGreaterThan(1);
  });
  it('bindTools returns itself (usable by createAgent)', () => {
    const m = new ScriptedChatModel([{ text: 'x' }]);
    expect(m.bindTools()).toBe(m);
  });
});

describe('ScriptedChatModelProvider', () => {
  it('creates fresh models from a script factory and can be taken offline', async () => {
    let n = 0;
    const p = new ScriptedChatModelProvider(() => [{ text: `run ${++n}` }]);
    expect((await p.createChatModel().invoke([new HumanMessage('x')])).content).toBe('run 1');
    expect((await p.createChatModel().invoke([new HumanMessage('x')])).content).toBe('run 2');
    expect((await p.checkHealth()).status).toBe('up');
    p.available = false;
    expect(() => p.assertAvailable()).toThrow(/offline/);
    expect((await p.checkHealth()).status).toBe('down');
  });
});
