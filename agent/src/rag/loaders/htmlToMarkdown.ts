import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export interface HtmlConversion {
  title?: string;
  markdown: string;
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'canvas', 'form'] as any);
turndown.addRule('dropSvg', { filter: (node) => node.nodeName.toLowerCase() === 'svg', replacement: () => '' });

/** Extracts the main readable content of an HTML page and converts it to Markdown. */
export function htmlToMarkdown(html: string): HtmlConversion {
  // linkedom needs a root element; wrap fragments such as "<p>hi</p>" or empty input.
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`);
  const title = document.querySelector('title')?.textContent?.trim() || undefined;

  let contentHtml: string | undefined;
  let articleTitle: string | undefined;
  try {
    const article = new Readability(document.cloneNode(true) as unknown as Document).parse();
    if (article?.content && (article.textContent?.trim().length ?? 0) > 80) {
      contentHtml = article.content;
      articleTitle = article.title || undefined;
    }
  } catch {
    // fall through to body extraction
  }
  if (contentHtml === undefined) {
    try {
      contentHtml = document.body?.innerHTML ?? document.documentElement?.innerHTML ?? '';
    } catch {
      contentHtml = '';
    }
  }

  let markdown = turndown.turndown(contentHtml).replace(/\n{3,}/g, '\n\n').trim();
  const finalTitle = articleTitle ?? title;
  // Readability drops a heading that duplicates the page title; keep it so the title text is searchable.
  if (finalTitle && markdown && !markdown.toLowerCase().includes(finalTitle.toLowerCase())) markdown = `# ${finalTitle}\n\n${markdown}`;
  return { title: finalTitle, markdown };
}
