import { z } from 'zod';
import type { AgentContext } from '../../context.js';
import { classifyError } from '../../resilience/errors.js';
import { ScrapeError, Scraper } from '../../web/Scraper.js';
import { BaseAgentTool, ToolOutput, ToolUserError } from '../BaseAgentTool.js';

/** Persistence port, implemented by the host application (the backend stores a DB row + vectors). */
export interface DocumentSink {
  saveText(
    context: AgentContext,
    doc: { title: string; text: string; sourceUrl?: string; mimeType?: string },
  ): Promise<{ documentId: string; chunksIndexed: number }>;
}

const schema = z.object({
  url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are supported').describe('Public web page to save into the user\'s knowledge base.'),
  title: z.string().max(200).optional().describe('Optional title; defaults to the page title.'),
});

export class SaveToKnowledgeBaseTool extends BaseAgentTool<typeof schema> {
  readonly name = 'save_to_knowledge_base';
  readonly description =
    "Fetches a public web page and saves it into the signed-in user's private knowledge base so later conversations can search and cite it. Only do this when the user asks to save/remember a page.";
  readonly schema = schema;
  override readonly authPolicy = { requiredScopes: ['web', 'kb:write'] };

  constructor(private readonly scraper: Scraper, private readonly sink: DocumentSink, private readonly options: { maxChars?: number } = {}) {
    super();
  }

  protected async run({ url, title }: z.infer<typeof schema>, ctx: AgentContext, signal?: AbortSignal): Promise<ToolOutput> {
    let page;
    try {
      page = await this.scraper.scrape(url, { signal, maxChars: this.options.maxChars ?? 80_000 });
    } catch (err) {
      if (err instanceof ScrapeError) throw new ToolUserError(err.message, err.retryable);
      if (classifyError(err).kind === 'aborted') throw err;
      throw new ToolUserError('The page could not be fetched.', true);
    }
    if (page.markdown.trim().length < 20) throw new ToolUserError('The page has no readable text to save.');

    try {
      const saved = await this.sink.saveText(ctx, {
        title: title || page.title || page.url,
        text: page.markdown,
        sourceUrl: page.url,
        mimeType: 'text/markdown',
      });
      return {
        data: { documentId: saved.documentId, chunksIndexed: saved.chunksIndexed, url: page.url, truncated: page.truncated },
        text: `Saved "${title || page.title || page.url}" to the knowledge base (${saved.chunksIndexed} passages). It can now be found with knowledge_base_search.`,
      };
    } catch (err) {
      if (err instanceof ToolUserError) throw err;
      throw new ToolUserError(`Could not save the page: ${(err as Error).message}`, classifyError(err).retryable);
    }
  }
}
