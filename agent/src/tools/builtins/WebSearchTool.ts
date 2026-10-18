import { z } from 'zod';
import { classifyError, friendlyMessage } from '../../resilience/errors.js';
import { fenceUntrusted } from '../../rag/retrieval/untrusted.js';
import type { SearchProvider } from '../../web/SearchProvider.js';
import { BaseAgentTool, ToolOutput, ToolUserError } from '../BaseAgentTool.js';

const schema = z.object({
  query: z.string().min(1).max(300).describe('Web search query.'),
  maxResults: z.number().int().min(1).max(8).optional().describe('Number of results (default 5).'),
});

export class WebSearchTool extends BaseAgentTool<typeof schema> {
  readonly name = 'web_search';
  readonly description = 'Searches the public web and returns result titles, URLs and snippets. Follow up with web_scrape to read a page in full.';
  readonly schema = schema;
  override readonly authPolicy = { requiredScopes: ['web'] };

  constructor(private readonly provider: SearchProvider) {
    super();
  }

  protected async run({ query, maxResults }: z.infer<typeof schema>, _ctx: unknown, signal?: AbortSignal): Promise<ToolOutput> {
    let hits;
    try {
      hits = await this.provider.search(query, { maxResults: maxResults ?? 5, signal });
    } catch (err) {
      const c = classifyError(err);
      if (c.kind === 'aborted') throw err;
      throw new ToolUserError(`Web search is unavailable right now. ${friendlyMessage(c.kind === 'unknown' ? 'unavailable' : c.kind, 'The search service')}`, true);
    }
    if (hits.length === 0) return { data: { results: [] }, text: 'The search returned no results.' };
    const text = fenceUntrusted(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n'), { tool: 'web_search' });
    return { data: { results: hits }, text };
  }
}
