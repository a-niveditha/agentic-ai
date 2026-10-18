import { z } from 'zod';
import { classifyError } from '../../resilience/errors.js';
import { fenceUntrusted } from '../../rag/retrieval/untrusted.js';
import { ScrapeError, Scraper } from '../../web/Scraper.js';
import { BaseAgentTool, ToolOutput, ToolUserError } from '../BaseAgentTool.js';

const schema = z.object({
  url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are supported').describe('Absolute http(s) URL of the page to read.'),
});

export class WebScrapeTool extends BaseAgentTool<typeof schema> {
  readonly name = 'web_scrape';
  readonly description = 'Fetches a public web page and returns its main content as Markdown so you can read it. Cannot access private/internal addresses.';
  readonly schema = schema;
  override readonly authPolicy = { requiredScopes: ['web'] };

  constructor(private readonly scraper: Scraper, private readonly options: { maxChars?: number } = {}) {
    super();
  }

  protected async run({ url }: z.infer<typeof schema>, _ctx: unknown, signal?: AbortSignal): Promise<ToolOutput> {
    try {
      const page = await this.scraper.scrape(url, { signal, maxChars: this.options.maxChars ?? 12_000 });
      const text =
        fenceUntrusted(page.markdown, { url: page.url, title: page.title }) +
        (page.truncated ? '\n(The page was truncated; only the beginning is shown.)' : '');
      return {
        data: { url: page.url, title: page.title, truncated: page.truncated, chars: page.markdown.length },
        text,
        citations: [{ title: page.title || page.url, source: page.url, url: page.url, content: page.markdown.slice(0, 400) }],
      };
    } catch (err) {
      if (err instanceof ScrapeError) throw new ToolUserError(err.message, err.retryable);
      if (classifyError(err).kind === 'aborted') throw err;
      throw new ToolUserError('The page could not be fetched.', true);
    }
  }
}
