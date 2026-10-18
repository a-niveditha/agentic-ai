import { CsvChunker } from './CsvChunker.js';
import { MarkdownChunker } from './MarkdownChunker.js';
import { PagedChunker } from './PagedChunker.js';
import { RecursiveChunker } from './RecursiveChunker.js';
import type { ChunkContext, Chunker } from './types.js';

/** Picks the chunking strategy for a document: the first registered chunker that supports it, else the fallback. */
export class ChunkerRegistry {
  private readonly chunkers: Chunker[] = [];

  constructor(private readonly fallback: Chunker = new RecursiveChunker()) {}

  /** Chunkers registered earlier win; register specific formats before generic ones. */
  register(chunker: Chunker): this {
    this.chunkers.push(chunker);
    return this;
  }

  select(context: ChunkContext): Chunker {
    return this.chunkers.find((c) => c.supports(context)) ?? this.fallback;
  }
}

export function createDefaultChunkerRegistry(): ChunkerRegistry {
  return new ChunkerRegistry().register(new PagedChunker()).register(new MarkdownChunker()).register(new CsvChunker());
}
