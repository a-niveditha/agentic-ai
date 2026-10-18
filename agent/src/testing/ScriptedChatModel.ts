import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatModelOptions, ChatModelProvider } from '../models/ChatModelProvider.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { HealthReport, healthReport } from '../resilience/health.js';

export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/** One scripted model turn: plain text, tool calls, or an error to throw. */
export type ScriptedTurn =
  | { text: string; toolCalls?: ScriptedToolCall[] }
  | { toolCalls: ScriptedToolCall[]; text?: string }
  | { error: Error }
  | ((messages: BaseMessage[]) => { text?: string; toolCalls?: ScriptedToolCall[] } | { error: Error });

/**
 * Deterministic chat model for tests and demos: replays a script of turns, supports tool calls and
 * token streaming, and records every prompt it was given. Exposed so downstream apps can test their
 * own tools and flows without a real LLM.
 */
export class ScriptedChatModel extends BaseChatModel {
  readonly received: BaseMessage[][] = [];
  private cursor = 0;

  constructor(private readonly script: ScriptedTurn[], private readonly repeatLast = false) {
    super({});
  }

  _llmType() {
    return 'scripted';
  }

  bindTools(): this {
    return this;
  }

  private nextTurn(messages: BaseMessage[]): { text: string; toolCalls: ScriptedToolCall[] } {
    this.received.push(messages);
    let turn = this.script[Math.min(this.cursor, this.script.length - 1)];
    if (this.cursor >= this.script.length && !this.repeatLast) throw new Error('ScriptedChatModel: script exhausted');
    this.cursor++;
    if (typeof turn === 'function') turn = turn(messages) as ScriptedTurn;
    if (!turn) throw new Error('ScriptedChatModel: empty script');
    if ('error' in turn) throw turn.error;
    return { text: (turn as any).text ?? '', toolCalls: (turn as any).toolCalls ?? [] };
  }

  async _generate(messages: BaseMessage[], _options: this['ParsedCallOptions'], _rm?: CallbackManagerForLLMRun): Promise<ChatResult> {
    const { text, toolCalls } = this.nextTurn(messages);
    const message = new AIMessage({
      content: text,
      tool_calls: toolCalls.map((c, i) => ({ name: c.name, args: c.args, id: c.id ?? `call_${this.cursor}_${i}`, type: 'tool_call' as const })),
    });
    return { generations: [{ message, text }] };
  }

  async *_streamResponseChunks(messages: BaseMessage[], _options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    const { text, toolCalls } = this.nextTurn(messages);
    const words = text.split(/(?<=\s)/).filter(Boolean);
    for (const word of words) {
      const chunk = new ChatGenerationChunk({ message: new AIMessageChunk({ content: word }), text: word });
      yield chunk;
      await runManager?.handleLLMNewToken(word);
    }
    if (toolCalls.length > 0 || words.length === 0) {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: toolCalls.map((c, i) => ({ name: c.name, args: JSON.stringify(c.args), id: c.id ?? `call_${this.cursor}_${i}`, index: i, type: 'tool_call_chunk' as const })),
        }),
        text: '',
      });
    }
  }
}

/** ChatModelProvider that serves a ScriptedChatModel (and lets tests flip availability). */
export class ScriptedChatModelProvider implements ChatModelProvider {
  readonly name = 'scripted';
  readonly modelId = 'scripted-model';
  readonly componentName = 'llm:scripted';
  readonly breaker = new CircuitBreaker({ name: 'llm:scripted', failureThreshold: 2, cooldownMs: 60_000 });
  available = true;
  lastModel?: ScriptedChatModel;

  constructor(private readonly script: ScriptedTurn[] | (() => ScriptedTurn[]), private readonly repeatLast = false) {}

  assertAvailable(): void {
    if (!this.available) throw Object.assign(new Error('scripted provider offline (503 unavailable)'), { status: 503 });
    this.breaker.assertAvailable();
    this.breaker.recordSuccess();
  }

  createChatModel(_options?: ChatModelOptions) {
    const script = typeof this.script === 'function' ? this.script() : this.script;
    this.lastModel = new ScriptedChatModel(script, this.repeatLast);
    return this.lastModel;
  }

  async checkHealth(): Promise<HealthReport> {
    return this.available ? healthReport('up') : healthReport('down', 'offline');
  }
}
