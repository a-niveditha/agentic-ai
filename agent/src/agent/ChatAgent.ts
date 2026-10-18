import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { createAgent, modelCallLimitMiddleware } from 'langchain';
import { AgentContext, AgentContextInput, parseAgentContext } from '../context.js';
import type { ChatModelProvider } from '../models/ChatModelProvider.js';
import { UNTRUSTED_NOTICE } from '../rag/retrieval/untrusted.js';
import type { Citation } from '../rag/types.js';
import { classifyError, friendlyMessage } from '../resilience/errors.js';
import { ToolBudget } from '../tools/budget.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import { StreamEvent, createEvent } from './events.js';
import type { HistoryMessage } from './memory.js';

export type RunStatus = 'completed' | 'interrupted' | 'limit_reached' | 'error';

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  ok?: boolean;
}

export interface ChatAgentResult {
  status: RunStatus;
  answer: string;
  citations: Citation[];
  toolCalls: ToolCallRecord[];
  error?: { message: string; code: string };
}

export interface ChatAgentOptions {
  modelProvider: ChatModelProvider;
  registry: ToolRegistry;
  /** Extra operator instructions appended to the built-in system prompt. */
  systemPrompt?: string;
  assistantName?: string;
}

export interface RunInput {
  /** Prior turns followed by the new user message (last element must be the new user message). */
  messages: HistoryMessage[];
  context: AgentContextInput;
  /** Condensed older conversation, from prepareHistory(). */
  summary?: string;
  retrievedKnowledge?: {
    status: 'found' | 'empty' | 'unavailable';
    context?: string;
  };
  /** ChatService emits start before doing its retrieval preflight. */
  startAlreadyEmitted?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
}

const MAX_TOOL_OUTPUT_EVENT_CHARS = 4_000;

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' || typeof part?.text === 'string' ? (part.text ?? '') : ''))
      .join('');
  }
  return '';
}

/**
 * Tool-using chat agent built on LangChain's `createAgent`. One instance is reusable across requests;
 * every `run()` binds a fresh, trusted AgentContext to the tools it is allowed to use.
 */
export class ChatAgent {
  constructor(private readonly options: ChatAgentOptions) {}

  buildSystemPrompt(summary?: string, retrievedKnowledge?: RunInput['retrievedKnowledge']): string {
    const name = this.options.assistantName ?? 'a helpful AI assistant';
    const knowledgeInstruction = retrievedKnowledge?.status === 'found'
      ? `A knowledge-base search has already run for this turn. Do not call knowledge_base_search again. The passages below came from this user's knowledge base. Use them as evidence when they answer or support the question about the user's documents; do not substitute web search for private-document evidence. If they do not answer the question, say that plainly.\n\n${retrievedKnowledge.context ?? ''}`
      : retrievedKnowledge?.status === 'empty'
        ? 'A knowledge-base search has already run for this turn and returned no passages. Do not call knowledge_base_search again. For questions about the user\'s documents, say you could not find the answer there instead of using web search as a substitute.'
        : retrievedKnowledge?.status === 'unavailable'
          ? 'A knowledge-base search was attempted but is unavailable for this turn. Do not call knowledge_base_search again. Say that clearly if the user asks about their documents; do not imply that you checked them.'
          : '';
    return [
      `You are ${name}. Today is ${new Date().toISOString().slice(0, 10)}.`,
      'Use the available tools when they help; prefer the knowledge base for questions about the user\'s own documents, and say so plainly when you could not find something.',
      'When you use information from a tool result, mention where it came from (document title or URL). Never invent sources.',
      'If a tool reports an error or that a capability is unavailable, continue as best you can and tell the user what you could not do.',
      UNTRUSTED_NOTICE,
      knowledgeInstruction,
      summary ? `Summary of the earlier conversation:\n${summary}` : '',
      this.options.systemPrompt ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  async run(input: RunInput): Promise<ChatAgentResult> {
    const context: AgentContext = parseAgentContext(input.context);
    const emit = (type: StreamEvent['type'], payload: unknown) => input.onEvent?.(createEvent(type, payload));
    const result: ChatAgentResult = { status: 'completed', answer: '', citations: [], toolCalls: [] };

    if (!input.startAlreadyEmitted) emit('start', { message: 'Agent started', executionId: context.executionId });

    const finish = (status: RunStatus, answer: string, error?: ChatAgentResult['error']): ChatAgentResult => {
      result.status = status;
      result.answer = answer;
      if (error) result.error = error;
      emit('done', { fullResponse: answer, citationsCount: result.citations.length, status });
      return result;
    };
    const fail = (kind: ReturnType<typeof classifyError>['kind'], code: string, partial: string) => {
      const message = friendlyMessage(kind, 'The AI model');
      emit('error', { message, code });
      return finish('error', partial, { message, code });
    };

    if (input.signal?.aborted) return finish('interrupted', '');

    let agent;
    try {
      this.options.modelProvider.assertAvailable();
      const model = this.options.modelProvider.createChatModel();
      const tools = this.options.registry.toolsFor(context, { signal: input.signal, budget: new ToolBudget(context.budget.maxToolCalls) });
      agent = createAgent({
        model,
        // ChatService already ran tenant-scoped KB retrieval before this agent call.
        tools: input.retrievedKnowledge ? tools.filter((tool) => tool.name !== 'knowledge_base_search') : tools,
        systemPrompt: this.buildSystemPrompt(input.summary, input.retrievedKnowledge),
        // Tool budget is enforced inside the tools (ToolBudget) so the model can still write a final answer.
        // Transient model errors are retried by the provider (see ChatModelProvider), not here.
        middleware: [modelCallLimitMiddleware({ runLimit: context.budget.maxModelCalls, exitBehavior: 'end' })] as any,
      } as any);
    } catch (err) {
      const c = classifyError(err);
      return fail(c.kind === 'unknown' ? 'unavailable' : c.kind, 'model_unavailable', '');
    }

    const lcMessages: BaseMessage[] = input.messages.map((m) => (m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)));

    const inputTexts = new Set(input.messages.map((m) => m.content));
    const seen = new Set<string>();
    const pending = new Map<string, ToolCallRecord>();
    // LangGraph can surface the same message in more than one node update (ToolMessages carry no stable id), so
    // tool lifecycle events are deduplicated by tool_call_id.
    const startedCalls = new Set<string>();
    const finishedCalls = new Set<string>();
    let streamed = '';
    let lastAiText = '';
    let aiMessages = 0;
    let limitHit = false;

    try {
      const stream = await agent.stream(
        { messages: lcMessages },
        { streamMode: ['messages', 'updates'], signal: input.signal, recursionLimit: context.budget.maxModelCalls * 3 + 10 } as any,
      );

      for await (const item of stream as AsyncIterable<[string, any]>) {
        const [mode, chunk] = item;

        if (mode === 'messages') {
          const [message] = chunk as [any, any];
          if (message?.getType?.() === 'ai' || message?._getType?.() === 'ai') {
            const token = textOf(message.content);
            if (token && !message.tool_call_chunks?.length) {
              streamed += token;
              emit('token', { token });
            }
          }
          continue;
        }

        if (mode !== 'updates') continue;
        for (const [node, nodeUpdate] of Object.entries(chunk ?? {}) as [string, any][]) {
          const messages: any[] = Array.isArray(nodeUpdate?.messages) ? nodeUpdate.messages : [];
          // Middleware nodes (before_model / after_model / after_agent) re-emit the entire state, history included,
          // so only the model and tool nodes carry new messages. The one thing read from a middleware node is the
          // message the call-limit middleware appends when it ends the run.
          if (node !== 'model_request' && node !== 'tools') {
            const last = messages.at(-1);
            const lastType = last?.getType?.() ?? last?._getType?.();
            const lastText = textOf(last?.content);
            if (lastType === 'ai' && !(last.tool_calls?.length > 0) && /model call limits? exceeded/i.test(lastText) && !inputTexts.has(lastText)) limitHit = true;
            continue;
          }
          for (const message of messages) {
            const type = message?.getType?.() ?? message?._getType?.();
            // Messages may be surfaced by more than one node update and not all carry an id: fall back to a
            // content-derived key so a message is never counted or emitted twice.
            const key: string =
              message?.id ??
              `anon:${type}:${message?.tool_call_id ?? ''}:${(message?.tool_calls ?? []).map((c: any) => c.id).join(',')}:${textOf(message?.content)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            if (type === 'ai') {
              aiMessages++;
              const text = textOf(message.content);
              if (text) lastAiText = text;
              for (const call of message.tool_calls ?? []) {
                const record: ToolCallRecord = { id: call.id ?? `${call.name}-${result.toolCalls.length}`, name: call.name, input: call.args };
                if (startedCalls.has(record.id)) continue;
                startedCalls.add(record.id);
                result.toolCalls.push(record);
                pending.set(record.id, record);
                emit('tool_start', { id: record.id, tool: record.name, input: record.input });
              }
            } else if (type === 'tool') {
              const callId: string = message.tool_call_id;
              if (finishedCalls.has(callId)) continue;
              finishedCalls.add(callId);
              const record = pending.get(callId);
              const artifact = message.artifact as { ok?: boolean; citations?: Citation[] } | undefined;
              const ok = artifact?.ok ?? message.status !== 'error';
              if (record) record.ok = ok;
              if (artifact?.citations?.length) {
                result.citations.push(...artifact.citations);
                emit('citation', { citations: artifact.citations });
              }
              emit('tool_end', {
                id: callId,
                tool: record?.name ?? message.name,
                success: ok,
                output: textOf(message.content).slice(0, MAX_TOOL_OUTPUT_EVENT_CHARS),
              });
            }
          }
        }
      }
    } catch (err) {
      const c = classifyError(err);
      const partial = lastAiText || streamed;
      if (c.kind === 'aborted' || input.signal?.aborted) return finish('interrupted', partial);
      return fail(c.kind === 'unknown' ? 'unavailable' : c.kind, c.kind === 'circuit_open' ? 'model_unavailable' : 'model_error', partial);
    }

    if (limitHit || aiMessages > context.budget.maxModelCalls) {
      const answer = lastAiText || streamed || 'I reached my step limit before I could finish. Please try a narrower question.';
      return finish('limit_reached', answer);
    }
    const answer = lastAiText || streamed;
    if (!answer.trim()) {
      emit('error', { message: 'The AI model returned an empty response. Please try again.', code: 'empty_response' });
      return finish('error', '', { message: 'The AI model returned an empty response. Please try again.', code: 'empty_response' });
    }
    return finish('completed', answer);
  }
}
