import { randomUUID } from 'node:crypto';
import {
  ChatAgent,
  ChatAgentResult,
  ChatModelProvider,
  HistoryMessage,
  StreamEvent,
  Citation,
  SearchResult,
  VectorStoreAdapter,
  createEvent,
  formatSources,
  prepareHistory,
  toCitation,
} from '@agentic-ai/agent';
import { AppError, conflict, notFound } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { AbstractStorageAdapter } from './AbstractStorageAdapter.js';
import type { IChatMessage } from './types.js';

export interface ChatServiceDeps {
  storage: AbstractStorageAdapter;
  agent: ChatAgent;
  modelProvider: ChatModelProvider;
  vectorStore: VectorStoreAdapter;
  logger: Logger;
  scopes: string[];
  limits: { maxToolCalls: number; maxModelCalls: number; historyMessages?: number };
}

export interface ChatTurnInput {
  userId: string;
  sessionId: string;
  text: string;
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

const DEFAULT_TITLE = 'New Conversation';
const KNOWLEDGE_TOP_K = 4;

function toHistory(messages: IChatMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (!m.content.trim()) continue;
    // Failed turns are shown to the user but must not be replayed to the model as if it had said them.
    if (m.sender === 'agent' && m.metadata) {
      try {
        if (JSON.parse(m.metadata)?.status === 'error') continue;
      } catch {
        /* ignore malformed metadata */
      }
    }
    out.push({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.content });
  }
  return out;
}

export class ChatService {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: ChatServiceDeps) {}

  private async retrieveKnowledge(userId: string, query: string, onEvent: (event: StreamEvent) => void) {
    if (!this.deps.scopes.includes('kb:read')) return undefined;

    const id = randomUUID();
    const input = { query, topK: KNOWLEDGE_TOP_K };
    onEvent(createEvent('tool_start', { id, tool: 'knowledge_base_search', input }));
    const toolCall = (ok: boolean) => ({ id, name: 'knowledge_base_search', input, ok });

    try {
      const documents = await this.deps.storage.listDocuments(userId);
      if (!documents.some((document) => document.status === 'ready')) {
        onEvent(createEvent('tool_end', { id, tool: 'knowledge_base_search', success: true, output: 'No ready documents are indexed for this account.' }));
        return { status: 'empty' as const, context: undefined, citations: [] as Citation[], toolCalls: [toolCall(true)] };
      }

      const results: SearchResult[] = await this.deps.vectorStore.similaritySearch(query, KNOWLEDGE_TOP_K, { userId });
      const citations = results.map(toCitation);
      if (citations.length) onEvent(createEvent('citation', { citations }));
      onEvent(createEvent('tool_end', {
        id,
        tool: 'knowledge_base_search',
        success: true,
        output: results.length ? `Retrieved ${results.length} passage${results.length === 1 ? '' : 's'} from the knowledge base.` : 'The search returned no passages.',
      }));
      return {
        status: results.length ? 'found' as const : 'empty' as const,
        context: results.length ? formatSources(results) : undefined,
        citations,
        toolCalls: [toolCall(true)],
      };
    } catch (err) {
      this.deps.logger.warn({ err, userId }, 'chat knowledge-base retrieval failed');
      onEvent(createEvent('tool_end', { id, tool: 'knowledge_base_search', success: false, output: 'Knowledge base search is unavailable.' }));
      return { status: 'unavailable' as const, context: undefined, citations: [] as Citation[], toolCalls: [toolCall(false)] };
    }
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId);
  }

  /** Cheap pre-flight so HTTP routes can return 404/409 before opening a stream. */
  async assertCanChat(userId: string, sessionId: string): Promise<void> {
    if (!(await this.deps.storage.getSession(userId, sessionId))) throw notFound('Session');
    if (this.busy.has(sessionId)) throw conflict('A response is already being generated for this session.', 'session_busy');
  }

  /**
   * One conversational turn: load history -> persist the user message -> run the agent (streaming) ->
   * persist the assistant message (with citations / tool calls / status). The user's message is saved before
   * the model is called, so an outage never loses what they typed.
   */
  async runChatTurn(input: ChatTurnInput): Promise<ChatAgentResult> {
    const { userId, sessionId, text, onEvent } = input;
    const session = await this.deps.storage.getSession(userId, sessionId);
    if (!session) throw notFound('Session');
    if (this.busy.has(sessionId)) throw conflict('A response is already being generated for this session.', 'session_busy');
    this.busy.add(sessionId);

    try {
      const priorRows = (await this.deps.storage.getMessages(userId, sessionId, { limit: this.deps.limits.historyMessages ?? 60 })) ?? [];
      const userMessage = await this.deps.storage.saveMessage(userId, sessionId, 'user', text);
      if (!userMessage) throw notFound('Session');

      const executionId = randomUUID();
      onEvent(createEvent('start', { message: 'Preparing your response', executionId }));

      let summarizer;
      try {
        summarizer = this.deps.modelProvider.createChatModel({ temperature: 0 });
      } catch {
        summarizer = undefined;
      }
      const prepared = await prepareHistory(toHistory(priorRows), { summarizer, signal: input.signal });
      const retrieval = await this.retrieveKnowledge(userId, text, onEvent);

      let agentDone: Record<string, unknown> = {};
      const result = await this.deps.agent.run({
        messages: [...prepared.messages, { role: 'user', content: text }],
        summary: prepared.summary,
        retrievedKnowledge: retrieval,
        startAlreadyEmitted: true,
        signal: input.signal,
        context: {
          principalId: userId,
          tenantId: userId,
          scopes: this.deps.scopes,
          executionId,
          budget: { maxToolCalls: this.deps.limits.maxToolCalls, maxModelCalls: this.deps.limits.maxModelCalls, maxTokens: 3000 },
        },
        onEvent: (event) => {
          if (event.type === 'done') agentDone = event.payload;
          else if (event.type === 'citation') {
            const fresh = event.payload.citations.filter((citation: Citation) => !retrieval?.citations.some((found) => found.sourceId === citation.sourceId && found.url === citation.url && found.page === citation.page && found.section === citation.section && found.content === citation.content));
            if (fresh.length) onEvent(createEvent('citation', { citations: fresh }));
          } else onEvent(event);
        },
      });

      const finalResult: ChatAgentResult = {
        ...result,
        citations: [...(retrieval?.citations ?? []), ...result.citations.filter((citation) => !retrieval?.citations.some((found) => found.sourceId === citation.sourceId && found.url === citation.url && found.page === citation.page && found.section === citation.section && found.content === citation.content))],
        toolCalls: [...(retrieval?.toolCalls ?? []), ...result.toolCalls],
      };

      const fallbackText =
        finalResult.status === 'error'
          ? `Sorry, I couldn't complete that request: ${finalResult.error?.message ?? 'an error occurred'}`
          : finalResult.status === 'interrupted'
            ? finalResult.answer
            : finalResult.answer;

      let assistantId: string | undefined;
      try {
        const saved = await this.deps.storage.saveMessage(userId, sessionId, 'agent', finalResult.answer || fallbackText, {
          status: finalResult.status,
          citations: finalResult.citations,
          toolCalls: finalResult.toolCalls.map((t) => ({ name: t.name, input: t.input, ok: t.ok })),
          error: finalResult.error,
        });
        assistantId = saved?.id;
        if (session.title === DEFAULT_TITLE) {
          await this.deps.storage.renameSession(userId, sessionId, text.trim().replace(/\s+/g, ' ').slice(0, 60) || DEFAULT_TITLE);
        }
      } catch (err) {
        this.deps.logger.error({ err, sessionId }, 'failed to persist assistant message');
        onEvent(createEvent('error', { message: 'The reply could not be saved to your history.', code: 'persist_failed' }));
      }

      onEvent(createEvent('done', { ...agentDone, sessionId, messageId: assistantId, fullResponse: finalResult.answer, citationsCount: finalResult.citations.length, status: finalResult.status }));
      return finalResult;
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

export { AppError };
