import type { ChunkOptions } from '../chunker.js';

/** Where in the source a chunk came from. Only primitives; stored with the chunk and shown in citations. */
export interface ChunkLocation {
  page?: number;
  section?: string;
  rowStart?: number;
  rowEnd?: number;
}

export interface TextChunk {
  text: string;
  metadata?: ChunkLocation;
}

/** What a chunker may use to decide whether it applies to a document. */
export interface ChunkContext {
  mimeType?: string;
  /** Filename or title; its extension is used when the MIME type is missing or generic. */
  filename?: string;
}

/**
 * Extension point: a strategy for cutting one kind of document into retrievable pieces. Chunks should be
 * self-contained, at most `chunkSize` characters (roughly), and carry a location when the format has one.
 */
export interface Chunker {
  readonly name: string;
  supports(context: ChunkContext): boolean;
  chunk(text: string, options: ChunkOptions): Promise<TextChunk[]>;
}

export function extensionOf(filename: string | undefined): string {
  const m = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(filename ?? '');
  return m ? m[1]!.toLowerCase() : '';
}

export function mimeBase(mimeType: string | undefined): string {
  return (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
}
