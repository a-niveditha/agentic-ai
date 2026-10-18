import { chunkTextToDocuments, type ChunkOptions } from '../chunker.js';
import type { ChunkContext, ChunkLocation, Chunker, TextChunk } from './types.js';

/** Default strategy: recursive splitting on paragraph, line, sentence and word boundaries. Works for any text. */
export class RecursiveChunker implements Chunker {
  readonly name = 'recursive';

  supports(_context: ChunkContext): boolean {
    return true;
  }

  async chunk(text: string, options: ChunkOptions, location?: ChunkLocation): Promise<TextChunk[]> {
    const docs = await chunkTextToDocuments(text, {}, options);
    return docs.map((d) => ({ text: d.pageContent, ...(location && Object.keys(location).length ? { metadata: { ...location } } : {}) }));
  }
}
