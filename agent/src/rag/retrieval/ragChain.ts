import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables';
import { ChatModelProvider } from '../../models/ChatModelProvider.js';
import { classifyError, friendlyMessage } from '../../resilience/errors.js';
import { RetrieveOptions, TenantRetriever, toCitation } from './retriever.js';
import { UNTRUSTED_NOTICE, fenceUntrusted } from './untrusted.js';
import type { Citation, SearchResult, VectorStoreAdapter } from '../types.js';

export type RagStatus = 'completed' | 'degraded' | 'unavailable' | 'no_context' | 'interrupted';

export interface RagAnswer {
  status: RagStatus;
  answer: string;
  citations: Citation[];
  error?: string;
}

export type RagEvent =
  | { type: 'start'; payload: { question: string } }
  | { type: 'citation'; payload: { citations: Citation[] } }
  | { type: 'token'; payload: { token: string } }
  | { type: 'error'; payload: { message: string; code: string } }
  | { type: 'done'; payload: { fullResponse: string; citationsCount: number; status: RagStatus } };

const SYSTEM = `You answer questions using ONLY the numbered sources provided. ${UNTRUSTED_NOTICE}
If the sources do not contain the answer, say you could not find it in the knowledge base instead of guessing.
Cite sources inline like [1] or [2]. Be concise.`;

export const NO_CONTEXT_MESSAGE = "I couldn't find anything about that in your knowledge base.";

export function formatSources(results: SearchResult[]): string {
  return results
    .map((r, i) => fenceUntrusted(r.document.pageContent, { id: i + 1, title: r.document.metadata.title, page: r.document.metadata.page, section: r.document.metadata.section }))
    .join('\n\n');
}

export interface StandaloneRagOptions {
  store: VectorStoreAdapter;
  modelProvider: ChatModelProvider;
  retrieve?: RetrieveOptions;
}

/**
 * Stand-alone retrieval-augmented answering (no agent loop): retrieve -> fenced prompt -> model.
 * Degrades instead of failing: if the model is down you still get the retrieved passages and citations;
 * if the vector store is down you get a clear "unavailable" status.
 */
export class StandaloneRagChain {
  constructor(private readonly options: StandaloneRagOptions) {}

  private retriever(userId: string, override?: RetrieveOptions) {
    return new TenantRetriever({ store: this.options.store, userId, topK: 4, maxTokens: 3000, ...this.options.retrieve, ...override });
  }

  private async fetchContext(question: string, userId: string, override?: RetrieveOptions): Promise<SearchResult[]> {
    return this.retriever(userId, override).search(question);
  }

  private buildChain() {
    const model = this.options.modelProvider.createChatModel({ temperature: 0.1 });
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', SYSTEM],
      ['human', 'Sources:\n{sources}\n\nQuestion: {question}'],
    ]);
    return RunnableSequence.from([
      RunnableLambda.from((input: { question: string; results: SearchResult[] }) => ({
        question: input.question,
        sources: formatSources(input.results),
      })),
      prompt,
      model,
      new StringOutputParser(),
    ]);
  }

  async answer(question: string, userId: string, opts: { signal?: AbortSignal; retrieve?: RetrieveOptions } = {}): Promise<RagAnswer> {
    return this.stream(question, userId, () => {}, opts);
  }

  async stream(
    question: string,
    userId: string,
    onEvent: (event: RagEvent) => void,
    opts: { signal?: AbortSignal; retrieve?: RetrieveOptions } = {},
  ): Promise<RagAnswer> {
    onEvent({ type: 'start', payload: { question } });
    const finish = (status: RagStatus, answer: string, citations: Citation[], error?: string): RagAnswer => {
      onEvent({ type: 'done', payload: { fullResponse: answer, citationsCount: citations.length, status } });
      return { status, answer, citations, error };
    };

    let results: SearchResult[];
    try {
      results = await this.fetchContext(question, userId, opts.retrieve);
    } catch (err) {
      const kind = classifyError(err).kind;
      const message = `${friendlyMessage(kind, 'The knowledge base')} `.trim();
      onEvent({ type: 'error', payload: { message, code: 'retrieval_unavailable' } });
      return finish('unavailable', '', [], message);
    }

    const citations = results.map(toCitation);
    if (citations.length > 0) onEvent({ type: 'citation', payload: { citations } });
    if (results.length === 0) {
      onEvent({ type: 'token', payload: { token: NO_CONTEXT_MESSAGE } });
      return finish('no_context', NO_CONTEXT_MESSAGE, []);
    }

    try {
      this.options.modelProvider.assertAvailable();
      let full = '';
      const stream = await this.buildChain().stream({ question, results }, { signal: opts.signal });
      for await (const token of stream) {
        if (!token) continue;
        full += token;
        onEvent({ type: 'token', payload: { token } });
      }
      return finish('completed', full, citations);
    } catch (err) {
      const c = classifyError(err);
      if (c.kind === 'aborted' || opts.signal?.aborted) return finish('interrupted', '', citations, 'Cancelled');
      // Model unavailable: degrade to the retrieved passages so the user still gets value.
      const message = `${friendlyMessage(c.kind, 'The language model')} Showing the most relevant passages instead.`;
      onEvent({ type: 'error', payload: { message, code: 'model_unavailable' } });
      const passages = results.map((r, i) => `[${i + 1}] ${r.document.pageContent}`).join('\n\n');
      return finish('degraded', passages, citations, message);
    }
  }
}
