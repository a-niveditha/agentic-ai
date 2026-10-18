import { DEFAULT_CHUNK_SIZE, type ChunkOptions } from '../chunker.js';
import { RecursiveChunker } from './RecursiveChunker.js';
import { extensionOf, mimeBase, type ChunkContext, type Chunker, type TextChunk } from './types.js';

const CSV_TYPES = new Set(['text/csv', 'text/tab-separated-values']);
const ROW = /^Row (\d+):/;

/**
 * Groups whole rows into chunks (never cutting a row in half) and records the row range. The CSV loader writes
 * each row as `Row N: column: value; …`, so every row is self-describing and needs no repeated header.
 */
export class CsvChunker implements Chunker {
  readonly name = 'tabular';
  private readonly recursive = new RecursiveChunker();

  supports({ mimeType, filename }: ChunkContext): boolean {
    return CSV_TYPES.has(mimeBase(mimeType)) || ['csv', 'tsv'].includes(extensionOf(filename));
  }

  async chunk(text: string, options: ChunkOptions): Promise<TextChunk[]> {
    const size = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const out: TextChunk[] = [];
    let lines: string[] = [];
    let length = 0;
    let first: number | undefined;
    let last: number | undefined;

    const flush = () => {
      if (lines.length === 0) return;
      out.push({ text: lines.join('\n'), metadata: first !== undefined ? { rowStart: first, rowEnd: last } : undefined });
      lines = [];
      length = 0;
      first = last = undefined;
    };

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row = ROW.exec(line);
      const rowNumber = row ? Number(row[1]) : undefined;
      if (line.length > size) {
        flush();
        for (const piece of await this.recursive.chunk(line, options, rowNumber !== undefined ? { rowStart: rowNumber, rowEnd: rowNumber } : undefined)) out.push(piece);
        continue;
      }
      if (length + line.length + 1 > size) flush();
      lines.push(line);
      length += line.length + 1;
      if (rowNumber !== undefined) {
        first ??= rowNumber;
        last = rowNumber;
      }
    }
    flush();
    return out;
  }
}
