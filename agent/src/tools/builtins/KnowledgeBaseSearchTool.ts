import { z } from 'zod';
import { AgentContext } from '../../context.js';
import { classifyError, friendlyMessage } from '../../resilience/errors.js';
import { TenantRetriever, publicMetadata, toCitation } from '../../rag/retrieval/retriever.js';
import { fenceUntrusted } from '../../rag/retrieval/untrusted.js';
import type { VectorStoreAdapter } from '../../rag/types.js';
import { BaseAgentTool, ToolOutput, ToolUserError } from '../BaseAgentTool.js';

const schema = z.object({
  query: z.string().min(1).max(500).describe('What to look for in the user\'s knowledge base.'),
  topK: z.number().int().min(1).max(10).optional().describe('How many passages to return (default 4).'),
});

export class KnowledgeBaseSearchTool extends BaseAgentTool<typeof schema> {
  readonly name = 'knowledge_base_search';
  readonly description =
    "Searches the signed-in user's private knowledge base (their uploaded documents and saved web pages) and returns the most relevant passages with sources. Use it before answering questions that may depend on their documents.";
  readonly schema = schema;
  override readonly authPolicy = { requiredScopes: ['kb:read'] };

  constructor(private readonly store: VectorStoreAdapter, private readonly options: { minScore?: number } = {}) {
    super();
  }

  protected async run({ query, topK }: z.infer<typeof schema>, ctx: AgentContext): Promise<ToolOutput> {
    // Identity is the trusted context, never anything the model typed.
    const retriever = new TenantRetriever({
      store: this.store,
      userId: ctx.tenantId,
      topK: topK ?? 4,
      minScore: this.options.minScore,
      maxTokens: ctx.budget.maxTokens ?? 3000,
    });

    let results;
    try {
      results = await retriever.search(query);
    } catch (err) {
      const c = classifyError(err);
      throw new ToolUserError(friendlyMessage(c.kind === 'unknown' ? 'unavailable' : c.kind, 'The knowledge base'), true);
    }

    if (results.length === 0) {
      return { data: { matches: 0, results: [] }, text: 'No relevant passages were found in the knowledge base.' };
    }
    const text = results
      .map((r, i) => fenceUntrusted(r.document.pageContent, { id: i + 1, title: r.document.metadata.title, source: r.document.metadata.sourceUrl, page: r.document.metadata.page, section: r.document.metadata.section }))
      .join('\n\n');
    return {
      data: { matches: results.length, results: results.map((r) => ({ content: r.document.pageContent, score: r.score, metadata: publicMetadata(r.document.metadata) })) },
      text,
      citations: results.map(toCitation),
    };
  }
}
