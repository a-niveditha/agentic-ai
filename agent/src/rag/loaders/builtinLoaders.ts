import mammoth from 'mammoth';
import Papa from 'papaparse';
// Import the implementation directly: the package index runs a debug harness when loaded outside CommonJS.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { BaseDocumentLoader, looksBinary } from './BaseDocumentLoader.js';
import { htmlToMarkdown } from './htmlToMarkdown.js';
import { BLANK_PAGE, LoadedDocument, LoaderError, LoaderInput, PAGE_BREAK } from './types.js';
import { assertZipIsSafe } from './zipGuard.js';

function decodeUtf8(buffer: Buffer, filename: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new LoaderError('corrupt', `'${filename}' is not valid UTF-8 text.`);
  }
}

export class TextLoader extends BaseDocumentLoader {
  readonly name = 'text';
  readonly extensions = ['txt', 'log', 'text'] as const;
  readonly mimeTypes = ['text/plain'] as const;
  protected async extract({ buffer, filename }: LoaderInput): Promise<LoadedDocument> {
    return { text: decodeUtf8(buffer, filename) };
  }
}

export class MarkdownLoader extends BaseDocumentLoader {
  readonly name = 'markdown';
  readonly extensions = ['md', 'markdown'] as const;
  readonly mimeTypes = ['text/markdown', 'text/x-markdown'] as const;
  protected async extract({ buffer, filename }: LoaderInput): Promise<LoadedDocument> {
    const text = decodeUtf8(buffer, filename);
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    return { text, title: heading };
  }
}

export class PdfLoader extends BaseDocumentLoader {
  readonly name = 'pdf';
  readonly extensions = ['pdf'] as const;
  readonly mimeTypes = ['application/pdf'] as const;
  constructor(private readonly options: { maxPages?: number; maxBytes?: number } = {}) {
    super({ maxBytes: options.maxBytes });
  }
  override matchesContent(buffer: Buffer): boolean {
    return buffer.subarray(0, 1024).includes('%PDF-');
  }
  protected async extract({ buffer }: LoaderInput): Promise<LoadedDocument> {
    // Collect text page by page so the page boundaries survive as form feeds (see PagedChunker).
    const pages: string[] = [];
    const data = await pdfParse(buffer, {
      max: this.options.maxPages ?? 300,
      pagerender: async (page) => {
        const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
        let lastY: number | undefined;
        let text = '';
        for (const item of content.items) {
          const y = item.transform?.[5];
          text += lastY === undefined || lastY === y ? item.str : `\n${item.str}`;
          lastY = y;
        }
        pages.push(text);
        return text;
      },
    });
    const hasText = pages.some((p) => p.trim().length > 0);
    return {
      // Blank pages keep a placeholder so later pages keep their numbers; a PDF with no text at all stays empty.
      text: hasText ? pages.map((p) => (p.trim() ? p : BLANK_PAGE)).join(PAGE_BREAK) : '',
      title: data.info?.Title || undefined,
      metadata: { pages: Number(data.numpages ?? 0) },
    };
  }
}

export class DocxLoader extends BaseDocumentLoader {
  readonly name = 'docx';
  readonly extensions = ['docx'] as const;
  readonly mimeTypes = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;
  override matchesContent(buffer: Buffer): boolean {
    return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
  }
  protected async extract({ buffer }: LoaderInput): Promise<LoadedDocument> {
    assertZipIsSafe(buffer);
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  }
}

export class HtmlLoader extends BaseDocumentLoader {
  readonly name = 'html';
  readonly extensions = ['html', 'htm'] as const;
  readonly mimeTypes = ['text/html', 'application/xhtml+xml'] as const;
  protected async extract({ buffer, filename }: LoaderInput): Promise<LoadedDocument> {
    const { markdown, title } = htmlToMarkdown(decodeUtf8(buffer, filename));
    return { text: markdown, title };
  }
}

export class CsvLoader extends BaseDocumentLoader {
  readonly name = 'csv';
  readonly extensions = ['csv', 'tsv'] as const;
  readonly mimeTypes = ['text/csv', 'text/tab-separated-values'] as const;
  constructor(private readonly options: { maxRows?: number; maxBytes?: number } = {}) {
    super({ maxBytes: options.maxBytes });
  }
  protected async extract({ buffer, filename }: LoaderInput): Promise<LoadedDocument> {
    const parsed = Papa.parse<Record<string, string>>(decodeUtf8(buffer, filename), { header: true, skipEmptyLines: true });
    const rows = parsed.data.slice(0, this.options.maxRows ?? 5_000);
    if (parsed.errors.length > 0 && rows.length === 0) {
      throw new LoaderError('corrupt', `CSV could not be parsed: ${parsed.errors[0]!.message}`);
    }
    const lines = rows.map((row, i) => {
      const cells = Object.entries(row)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}: ${v}`);
      return `Row ${i + 1}: ${cells.join('; ')}`;
    });
    return { text: lines.join('\n'), metadata: { rows: rows.length, truncated: parsed.data.length > rows.length } };
  }
}

export class JsonLoader extends BaseDocumentLoader {
  readonly name = 'json';
  readonly extensions = ['json'] as const;
  readonly mimeTypes = ['application/json'] as const;
  protected async extract({ buffer, filename }: LoaderInput): Promise<LoadedDocument> {
    const value = JSON.parse(decodeUtf8(buffer, filename));
    return { text: JSON.stringify(value, null, 2) };
  }
}

export { looksBinary };
