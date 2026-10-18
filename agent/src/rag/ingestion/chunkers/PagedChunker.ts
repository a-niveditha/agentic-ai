import { BLANK_PAGE, PAGE_BREAK } from '../../loaders/types.js';
import type { ChunkOptions } from '../chunker.js';
import { RecursiveChunker } from './RecursiveChunker.js';
import { extensionOf, mimeBase, type ChunkContext, type Chunker, type TextChunk } from './types.js';

/** Splits paged documents (PDF) on page breaks, so every chunk knows its page and never spans two. */
export class PagedChunker implements Chunker {
  readonly name = 'paged';
  private readonly recursive = new RecursiveChunker();

  supports({ mimeType, filename }: ChunkContext): boolean {
    return mimeBase(mimeType) === 'application/pdf' || extensionOf(filename) === 'pdf';
  }

  async chunk(text: string, options: ChunkOptions): Promise<TextChunk[]> {
    if (!text.includes(PAGE_BREAK)) return this.recursive.chunk(text, options);
    const out: TextChunk[] = [];
    const pages = text.split(PAGE_BREAK);
    for (let i = 0; i < pages.length; i++) {
      const pageText = pages[i]!.split(BLANK_PAGE).join('').trim();
      if (!pageText) continue;
      out.push(...(await this.recursive.chunk(pageText, options, { page: i + 1 })));
    }
    return out;
  }
}
