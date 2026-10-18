export type LoaderErrorCode = 'unsupported' | 'empty' | 'corrupt' | 'too_large' | 'mismatch';

export class LoaderError extends Error {
  constructor(public readonly code: LoaderErrorCode, message: string) {
    super(message);
    this.name = 'LoaderError';
  }
}

export interface LoaderInput {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}

export interface LoadedDocument {
  text: string;
  title?: string;
  /** Primitive-only extras (page count, row count...). */
  metadata?: Record<string, string | number | boolean>;
}

/** Extension point: turn raw bytes of one file format into plain text. */
export interface DocumentLoader {
  readonly name: string;
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
  /** Cheap structural sniff on the raw bytes (magic number / not-binary). */
  matchesContent(buffer: Buffer): boolean;
  load(input: LoaderInput): Promise<LoadedDocument>;
}

/** Page separator (form feed) that paged loaders such as PDF emit between pages; the ingestion `PagedChunker` splits on it. */
export const PAGE_BREAK = '\f';
/** Stands in for a page without text so that the numbers of later pages stay correct. */
export const BLANK_PAGE = '\u200B';
