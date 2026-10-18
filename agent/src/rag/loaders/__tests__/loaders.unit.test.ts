import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { FACTS, buildDocx, buildFixtureFiles, buildHtml, buildPdf, buildPdfPages } from '../../../../../tests/helpers/fixtures.js';
import { BaseDocumentLoader, looksBinary, normalizeText } from '../BaseDocumentLoader.js';
import { BLANK_PAGE, PAGE_BREAK } from '../types.js';
import { CsvLoader, DocxLoader, HtmlLoader, JsonLoader, MarkdownLoader, PdfLoader, TextLoader } from '../builtinLoaders.js';
import { htmlToMarkdown } from '../htmlToMarkdown.js';
import { LoaderRegistry, createDefaultLoaderRegistry } from '../LoaderRegistry.js';
import { LoaderError, type LoadedDocument, type LoaderInput } from '../types.js';
import { assertZipIsSafe } from '../zipGuard.js';

const input = (filename: string, buffer: Buffer, mimeType?: string): LoaderInput => ({ filename, buffer, mimeType });
const code = async (p: Promise<unknown>) => (await p.catch((e) => e)) as LoaderError;

describe('normalizeText / looksBinary', () => {
  it('normalizes newlines, NULs and excess blank lines', () => {
    expect(normalizeText('a\r\nb\r\n\r\n\r\n\r\n\r\nc\u0000  \n')).toBe('a\nb\n\n\nc');
  });
  it('detects NUL bytes in the first 8KB', () => {
    expect(looksBinary(Buffer.from([65, 0, 66]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
  });
});

describe('BaseDocumentLoader template', () => {
  class Echo extends BaseDocumentLoader {
    readonly name = 'echo';
    readonly extensions = ['echo'] as const;
    readonly mimeTypes = [] as const;
    throwWith?: Error;
    protected async extract({ buffer }: LoaderInput): Promise<LoadedDocument> {
      if (this.throwWith) throw this.throwWith;
      return { text: buffer.toString() };
    }
  }
  it('rejects empty, oversized and binary payloads', async () => {
    const l = new Echo({ maxBytes: 10 });
    expect((await code(l.load(input('a.echo', Buffer.alloc(0))))).code).toBe('empty');
    expect((await code(l.load(input('a.echo', Buffer.from('x'.repeat(11)))))).code).toBe('too_large');
    expect((await code(new Echo().load(input('a.echo', Buffer.from([1, 0, 2]))))).code).toBe('mismatch');
  });
  it('maps unexpected parser errors to corrupt and whitespace-only output to empty', async () => {
    const l = new Echo();
    l.throwWith = new Error('boom');
    expect((await code(l.load(input('a.echo', Buffer.from('x'))))).code).toBe('corrupt');
    l.throwWith = undefined;
    expect((await code(l.load(input('a.echo', Buffer.from('  \n  '))))).code).toBe('empty');
  });
  it('passes LoaderErrors through unchanged', async () => {
    const l = new Echo();
    l.throwWith = new LoaderError('too_large', 'custom');
    expect((await code(l.load(input('a.echo', Buffer.from('x'))))).message).toBe('custom');
  });
});

describe('builtin loaders', () => {
  it('text', async () => {
    const d = await new TextLoader().load(input('a.txt', Buffer.from('héllo wörld')));
    expect(d.text).toBe('héllo wörld');
  });
  it('text: invalid UTF-8 is corrupt', async () => {
    expect((await code(new TextLoader().load(input('a.txt', Buffer.from([0xff, 0xfe, 0xfd, 0x41]))))).code).toBe('corrupt');
  });
  it('markdown extracts the first heading as title', async () => {
    const d = await new MarkdownLoader().load(input('a.md', Buffer.from('intro\n# My Title\nbody')));
    expect(d.title).toBe('My Title');
  });
  it('pdf extracts text + page count', async () => {
    const d = await new PdfLoader().load(input('a.pdf', buildPdf(FACTS.pdf.text)));
    expect(d.text).toContain('Kestrel Accord');
    expect(d.metadata?.pages).toBe(1);
  });
  it('pdf keeps page boundaries as form feeds so later stages can cite page numbers', async () => {
    const d = await new PdfLoader().load(input('a.pdf', buildPdfPages(['Alpha on page one', 'Beta on page two', 'Gamma on page three'])));
    expect(d.text.split(PAGE_BREAK).map((p) => p.trim())).toEqual(['Alpha on page one', 'Beta on page two', 'Gamma on page three']);
    expect(d.metadata).toMatchObject({ pages: 3 });
  });

  it('pdf: blank pages keep a placeholder so later page numbers stay right; a PDF with no text at all is empty', async () => {
    const d = await new PdfLoader().load(input('a.pdf', buildPdfPages(['', 'Real text on page two', '', 'Page four text'])));
    const pages = d.text.split(PAGE_BREAK);
    expect(pages).toHaveLength(4);
    expect(pages[0]).toBe(BLANK_PAGE);
    expect(pages[1]).toContain('page two');
    expect((await code(new PdfLoader().load(input('scan.pdf', buildPdfPages(['', '']))))).code).toBe('empty');
  });

  it('pdf: non-pdf bytes are a mismatch, truncated pdf is corrupt', async () => {
    expect((await code(new PdfLoader().load(input('a.pdf', Buffer.from('just text'))))).code).toBe('mismatch');
    const broken = buildPdf('hi').subarray(0, 40);
    expect(['corrupt', 'empty']).toContain((await code(new PdfLoader().load(input('a.pdf', broken)))).code);
  });
  it('docx extracts text', async () => {
    const d = await new DocxLoader().load(input('a.docx', await buildDocx(FACTS.docx.text)));
    expect(d.text).toContain('Plumbline Initiative');
  });
  it('docx: plain text renamed .docx is a mismatch; random zip is corrupt', async () => {
    expect((await code(new DocxLoader().load(input('a.docx', Buffer.from('not a zip'))))).code).toBe('mismatch');
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    const notDocx = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    expect((await code(new DocxLoader().load(input('a.docx', notDocx))))).toBeInstanceOf(LoaderError);
  });
  it('html: keeps article content, drops script/nav', async () => {
    const d = await new HtmlLoader().load(input('a.html', buildHtml(FACTS.html.text)));
    expect(d.text).toContain('Brindlewick');
    expect(d.text).not.toContain("alert('x')");
    expect(d.title).toBeTruthy();
  });
  it('csv turns rows into readable lines and caps rows', async () => {
    const d = await new CsvLoader().load(input('a.csv', Buffer.from(FACTS.csv.text)));
    expect(d.text).toContain('Row 1: name: Alderfern Quibble; role: chief cartographer');
    const big = 'a,b\n' + Array.from({ length: 20 }, (_, i) => `${i},x`).join('\n');
    const capped = await new CsvLoader({ maxRows: 5 }).load(input('a.csv', Buffer.from(big)));
    expect(capped.text.split('\n')).toHaveLength(5);
    expect(capped.metadata?.truncated).toBe(true);
  });
  it('json pretty-prints and rejects invalid json', async () => {
    const d = await new JsonLoader().load(input('a.json', Buffer.from(FACTS.json.text)));
    expect(d.text).toContain('"launchCodename": "Tangerine Owl"');
    expect((await code(new JsonLoader().load(input('a.json', Buffer.from('{not json')))))).toMatchObject({ code: 'corrupt' });
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings/lists/links to markdown', () => {
    const { markdown, title } = htmlToMarkdown('<html><head><title>T</title></head><body><article><h1>Head</h1><p>Intro paragraph that is long enough to be treated as real content by the extractor, definitely.</p><ul><li>one</li><li>two</li></ul><a href="https://x.test">link</a></article></body></html>');
    expect(markdown).toContain('# Head');
    expect(markdown).toMatch(/-\s+one/);
    expect(markdown).toContain('[link](https://x.test)');
    expect(title).toBeTruthy();
  });
  it('falls back to the body when there is no article-like content', () => {
    const { markdown } = htmlToMarkdown('<html><body><div>short</div></body></html>');
    expect(markdown).toContain('short');
  });
  it('strips scripts, styles and svg', () => {
    const { markdown } = htmlToMarkdown('<body><p>visible text here</p><script>evil()</script><style>.x{}</style><svg><text>svgtext</text></svg></body>');
    expect(markdown).toContain('visible');
    expect(markdown).not.toMatch(/evil|\.x\{|svgtext/);
  });
  it('tolerates garbage', () => {
    expect(htmlToMarkdown('<<<not html').markdown).toBeDefined();
    expect(htmlToMarkdown('').markdown).toBe('');
  });
});

describe('zipGuard', () => {
  async function zipWith(fn: (z: JSZip) => void, compression: 'DEFLATE' | 'STORE' = 'DEFLATE') {
    const z = new JSZip();
    fn(z);
    return Buffer.from(await z.generateAsync({ type: 'uint8array', compression }));
  }
  it('accepts a normal archive', async () => {
    const ok = await zipWith((z) => z.file('a.txt', 'hello'));
    expect(() => assertZipIsSafe(ok)).not.toThrow();
  });
  it('rejects a high-ratio archive (zip bomb)', async () => {
    const bomb = await zipWith((z) => z.file('bomb.txt', Buffer.alloc(30 * 1024 * 1024, 0)));
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => assertZipIsSafe(bomb)).toThrow(/zip bomb/);
  }, 30_000);
  it('rejects archives with too many entries', async () => {
    const many = await zipWith((z) => { for (let i = 0; i < 50; i++) z.file(`f${i}.txt`, 'x'); });
    expect(() => assertZipIsSafe(many, { maxEntries: 10, maxUncompressedBytes: 1e9, maxRatio: 1e9 })).toThrow(/too many entries/);
  });
  it('rejects total expansion over the limit', async () => {
    const big = await zipWith((z) => { z.file('a.bin', Buffer.alloc(5000, 1)); z.file('b.bin', Buffer.alloc(5000, 2)); }, 'STORE');
    expect(() => assertZipIsSafe(big, { maxEntries: 10, maxUncompressedBytes: 6000, maxRatio: 1e9 })).toThrow(/too much data/);
  });
  it('rejects non-zip and corrupted central directories', () => {
    expect(() => assertZipIsSafe(Buffer.from('definitely not a zip file at all, just text'))).toThrow(LoaderError);
    expect(() => assertZipIsSafe(Buffer.alloc(10))).toThrow(LoaderError);
  });
  it('DocxLoader refuses a docx-shaped zip bomb before inflating it', async () => {
    const bomb = await zipWith((z) => z.file('word/document.xml', Buffer.alloc(30 * 1024 * 1024, 0x41)));
    expect((await code(new DocxLoader().load(input('evil.docx', bomb)))).code).toBe('too_large');
  }, 30_000);
});

describe('LoaderRegistry', () => {
  const registry = createDefaultLoaderRegistry();

  it('loads every supported fixture type end to end', async () => {
    for (const f of await buildFixtureFiles()) {
      const doc = await registry.load({ filename: f.filename, buffer: f.buffer, mimeType: f.mimeType });
      expect(doc.text.length).toBeGreaterThan(5);
      expect(doc.text).toContain(FACTS[f.kind].answer.split(' ')[0]!.replace('$', ''));
    }
  });

  it('lists supported extensions', () => {
    expect(registry.supportedExtensions()).toEqual(expect.arrayContaining(['txt', 'md', 'pdf', 'docx', 'html', 'csv', 'json']));
  });

  it('is case-insensitive on extensions', async () => {
    expect((await registry.load(input('NOTES.TXT', Buffer.from('hello')))).loader).toBe('text');
  });

  it('rejects unsupported types with a helpful message', async () => {
    const e = await code(registry.load(input('virus.exe', Buffer.from('MZ'))));
    expect(e.code).toBe('unsupported');
    expect(e.message).toContain('Supported:');
  });

  it('rejects files with no extension and a generic mime type, but accepts a specific mime', async () => {
    expect((await code(registry.load(input('README', Buffer.from('hi'), 'application/octet-stream')))).code).toBe('unsupported');
    expect((await registry.load(input('README', Buffer.from('hi'), 'text/plain'))).loader).toBe('text');
  });

  it('SPOOFING: a PDF hiding behind .txt is rejected', async () => {
    expect((await code(registry.load(input('notes.txt', buildPdf('secret'))))).code).toBe('mismatch');
  });

  it('SPOOFING: text renamed .pdf / .docx is rejected as a mismatch', async () => {
    expect((await code(registry.load(input('a.pdf', Buffer.from('plain'))))).code).toBe('mismatch');
    expect((await code(registry.load(input('a.docx', Buffer.from('plain'))))).code).toBe('mismatch');
  });

  it('SPOOFING: arbitrary binary renamed .txt is rejected', async () => {
    expect((await code(registry.load(input('a.txt', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]))))).code).toBe('mismatch');
  });

  it('reports empty files and empty content', async () => {
    expect((await code(registry.load(input('a.txt', Buffer.alloc(0))))).code).toBe('empty');
    expect((await code(registry.load(input('a.md', Buffer.from('\n\n  \n'))))).code).toBe('empty');
  });

  it('enforces the configured size limit across loaders', async () => {
    const small = createDefaultLoaderRegistry({ maxBytes: 100 });
    expect((await code(small.load(input('a.txt', Buffer.alloc(101, 65))))).code).toBe('too_large');
  });

  it('supports custom loaders via register()', async () => {
    class Rot13 extends BaseDocumentLoader {
      readonly name = 'rot13'; readonly extensions = ['rot'] as const; readonly mimeTypes = [] as const;
      protected async extract({ buffer }: LoaderInput) { return { text: buffer.toString().replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)) }; }
    }
    const reg = new LoaderRegistry().register(new Rot13());
    expect((await reg.load(input('x.rot', Buffer.from('uryyb')))).text).toBe('hello');
  });
});
