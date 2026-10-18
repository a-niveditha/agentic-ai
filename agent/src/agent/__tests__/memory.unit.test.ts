import { describe, expect, it } from 'bun:test';
import { ScriptedChatModel } from '../../testing/ScriptedChatModel.js';
import { prepareHistory, type HistoryMessage } from '../memory.js';

const convo = (n: number, size = 20): HistoryMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i} ` + 'x'.repeat(size) }) as HistoryMessage);

describe('prepareHistory', () => {
  it('leaves short conversations untouched', async () => {
    const h = convo(6);
    const p = await prepareHistory(h);
    expect(p).toEqual({ messages: h, trimmed: false });
  });

  it('trims to the most recent messages when over the message budget (no summarizer)', async () => {
    const p = await prepareHistory(convo(40), { maxMessages: 10, keepRecent: 4 });
    expect(p.trimmed).toBe(true);
    expect(p.messages.length).toBeLessThanOrEqual(4);
    expect(p.messages.at(-1)!.content.startsWith('m39')).toBe(true);
    expect(p.summary).toBeUndefined();
  });

  it('never starts with an assistant turn', async () => {
    const p = await prepareHistory(convo(41), { maxMessages: 10, keepRecent: 5 });
    expect(p.messages[0]!.role).toBe('user');
  });

  it('trims by character budget but always keeps the latest message', async () => {
    const p = await prepareHistory(convo(12, 500), { maxMessages: 100, maxChars: 1200, keepRecent: 10 });
    expect(p.trimmed).toBe(true);
    expect(p.messages.length).toBeGreaterThanOrEqual(1);
    expect(p.messages.at(-1)!.content.startsWith('m11')).toBe(true);
  });

  it('summarizes the dropped part when a summarizer is available', async () => {
    const summarizer = new ScriptedChatModel([{ text: 'User asked about widgets; we agreed on blue.' }], true);
    const p = await prepareHistory(convo(40), { maxMessages: 10, keepRecent: 4, summarizer });
    expect(p.summary).toBe('User asked about widgets; we agreed on blue.');
    expect(p.summarizationFailed).toBeUndefined();
    const sent = summarizer.received[0]!.map((m) => String(m.content)).join('\n');
    expect(sent).toContain('m0');
    expect(sent).not.toContain('m39');
  });

  it('DEGRADES: if summarization fails, silently falls back to trimming', async () => {
    const summarizer = new ScriptedChatModel([{ error: Object.assign(new Error('429'), { status: 429 }) }], true);
    const p = await prepareHistory(convo(40), { maxMessages: 10, keepRecent: 4, summarizer });
    expect(p.summary).toBeUndefined();
    expect(p.summarizationFailed).toBe(true);
    expect(p.messages.length).toBeLessThanOrEqual(4);
  });

  it('DEGRADES: an empty summary also counts as failure', async () => {
    const summarizer = new ScriptedChatModel([{ text: '   ' }], true);
    const p = await prepareHistory(convo(40), { maxMessages: 10, keepRecent: 4, summarizer });
    expect(p.summarizationFailed).toBe(true);
  });
});
