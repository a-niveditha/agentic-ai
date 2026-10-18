import type { TextChunk } from './chunkers/types.js';

/** What a stage may know about the document being ingested. Read-only. */
export interface IngestionContext {
  userId: string;
  sourceId: string;
  title?: string;
  mimeType?: string;
  sourceUrl?: string;
}

/**
 * Extension point (before chunking): rewrite the whole text, e.g. strip boilerplate or redact personal data.
 * Runs in order; the output of one is the input of the next. Throwing fails the ingestion.
 */
export interface TextTransformer {
  readonly name: string;
  transform(text: string, context: IngestionContext): string | Promise<string>;
}

/**
 * Extension point (after chunking): adjust or drop chunks, e.g. remove near-empty chunks or add a location.
 * Return the chunks to keep. Only primitive metadata values are stored.
 */
export interface ChunkEnricher {
  readonly name: string;
  enrich(chunks: TextChunk[], context: IngestionContext): TextChunk[] | Promise<TextChunk[]>;
}

/** Drops chunks that carry too little text to be useful in retrieval (page numbers, stray bullets…). */
export class MinLengthFilter implements ChunkEnricher {
  readonly name = 'min-length-filter';
  constructor(private readonly minChars = 20) {}
  enrich(chunks: TextChunk[]): TextChunk[] {
    return chunks.filter((c) => c.text.trim().length >= this.minChars);
  }
}

export interface PiiRedactorOptions {
  emails?: boolean;
  phones?: boolean;
  /** Payment card numbers (13–19 digits that pass the Luhn check). */
  cards?: boolean;
  /** US social security numbers (ddd-dd-dddd). */
  ssn?: boolean;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Opt-in redaction of common personal data before text is embedded and stored. It is a pattern-based
 * safeguard, not a compliance guarantee: names, addresses and free-form identifiers are not detected.
 */
export class PiiRedactor implements TextTransformer {
  readonly name = 'pii-redactor';
  private readonly options: Required<PiiRedactorOptions>;

  constructor(options: PiiRedactorOptions = {}) {
    this.options = { emails: true, phones: true, cards: true, ssn: true, ...options };
  }

  transform(text: string): string {
    let out = text;
    if (this.options.emails) out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
    if (this.options.cards) {
      out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
        const digits = m.replace(/\D/g, '');
        return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[CARD]' : m;
      });
    }
    if (this.options.ssn) out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');
    if (this.options.phones) out = out.replace(/(?<![\w-])(?:\+?\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{3,4}\b/g, '[PHONE]');
    return out;
  }
}
