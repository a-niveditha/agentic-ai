import { LoadedDocument, DocumentLoader, LoaderError, LoaderInput } from './types.js';

const BINARY_SIGNATURES: number[][] = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x50, 0x4b, 0x03, 0x04], // zip / docx / xlsx / jar
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // Windows PE
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x1f, 0x8b], // gzip
  [0xd0, 0xcf, 0x11, 0xe0], // legacy OLE (.doc/.xls)
];

/** Binary payloads (NUL bytes or a known file-format signature) must never be indexed as text. */
export function looksBinary(buffer: Buffer): boolean {
  if (BINARY_SIGNATURES.some((sig) => sig.every((b, i) => buffer[i] === b))) return true;
  const sample = buffer.subarray(0, 8192);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** Template method: size limit, sniffing, error normalization and empty-text detection live here. */
export abstract class BaseDocumentLoader implements DocumentLoader {
  abstract readonly name: string;
  abstract readonly extensions: readonly string[];
  abstract readonly mimeTypes: readonly string[];
  readonly maxBytes: number;

  constructor(options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  }

  /** Text formats: reject binary. Binary formats override with a magic-number check. */
  matchesContent(buffer: Buffer): boolean {
    return !looksBinary(buffer);
  }

  protected abstract extract(input: LoaderInput): Promise<LoadedDocument>;

  async load(input: LoaderInput): Promise<LoadedDocument> {
    if (input.buffer.length === 0) throw new LoaderError('empty', `'${input.filename}' is empty.`);
    if (input.buffer.length > this.maxBytes) {
      throw new LoaderError('too_large', `'${input.filename}' exceeds the ${Math.round(this.maxBytes / 1024 / 1024)}MB limit.`);
    }
    if (!this.matchesContent(input.buffer)) {
      throw new LoaderError('mismatch', `'${input.filename}' content does not match the ${this.name} format.`);
    }
    let doc: LoadedDocument;
    try {
      doc = await this.extract(input);
    } catch (err) {
      if (err instanceof LoaderError) throw err;
      throw new LoaderError('corrupt', `Could not read '${input.filename}' as ${this.name}: ${(err as Error).message}`);
    }
    const text = normalizeText(doc.text);
    if (!text) throw new LoaderError('empty', `No extractable text found in '${input.filename}'.`);
    return { ...doc, text };
  }
}
