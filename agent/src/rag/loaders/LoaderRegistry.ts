import { extname } from 'node:path';
import { DocumentLoader, LoadedDocument, LoaderError, LoaderInput } from './types.js';
import { CsvLoader, DocxLoader, HtmlLoader, JsonLoader, MarkdownLoader, PdfLoader, TextLoader } from './builtinLoaders.js';

const PDF_MAGIC = '%PDF-';

export class LoaderRegistry {
  private readonly loaders: DocumentLoader[] = [];

  register(loader: DocumentLoader): this {
    this.loaders.push(loader);
    return this;
  }

  supportedExtensions(): string[] {
    return this.loaders.flatMap((l) => [...l.extensions]).sort();
  }

  /** Picks a loader from the filename/MIME, then verifies the bytes really are that format. */
  resolve(input: Pick<LoaderInput, 'filename' | 'mimeType' | 'buffer'>): DocumentLoader {
    const ext = extname(input.filename).slice(1).toLowerCase();
    const mime = (input.mimeType ?? '').split(';')[0]!.trim().toLowerCase();

    let loader = this.loaders.find((l) => ext && l.extensions.includes(ext));
    // Generic MIME types carry no information; only trust a specific one when the extension is missing.
    if (!loader && !ext && mime && mime !== 'application/octet-stream') {
      loader = this.loaders.find((l) => l.mimeTypes.includes(mime));
    }
    if (!loader) {
      throw new LoaderError('unsupported', `Unsupported file type '${ext ? '.' + ext : mime || 'unknown'}'. Supported: ${this.supportedExtensions().join(', ')}.`);
    }
    // A binary payload hiding behind a text extension (or vice versa) is rejected by the loader's sniff.
    if (!loader.matchesContent(input.buffer)) {
      const looksPdf = input.buffer.subarray(0, 1024).includes(PDF_MAGIC);
      throw new LoaderError('mismatch', `'${input.filename}' does not look like a valid ${loader.name} file${looksPdf ? ' (it appears to be a PDF)' : ''}.`);
    }
    return loader;
  }

  async load(input: LoaderInput): Promise<LoadedDocument & { loader: string }> {
    const loader = this.resolve(input);
    const doc = await loader.load(input);
    return { ...doc, loader: loader.name };
  }
}

export function createDefaultLoaderRegistry(options: { maxBytes?: number } = {}): LoaderRegistry {
  const o = { maxBytes: options.maxBytes };
  return new LoaderRegistry()
    .register(new TextLoader(o))
    .register(new MarkdownLoader(o))
    .register(new PdfLoader(o))
    .register(new DocxLoader(o))
    .register(new HtmlLoader(o))
    .register(new CsvLoader(o))
    .register(new JsonLoader(o));
}
