import { describe, expect, it } from 'bun:test';
import { BLANK_PAGE, PAGE_BREAK } from '../../loaders/types.js';
import { CsvChunker } from '../chunkers/CsvChunker.js';
import { ChunkerRegistry, createDefaultChunkerRegistry } from '../chunkers/ChunkerRegistry.js';
import { MarkdownChunker, splitSections } from '../chunkers/MarkdownChunker.js';
import { PagedChunker } from '../chunkers/PagedChunker.js';
import { RecursiveChunker } from '../chunkers/RecursiveChunker.js';

describe('RecursiveChunker', () => {
  it('splits long text, supports everything, adds no location', async () => {
    const c = new RecursiveChunker();
    expect(c.supports({})).toBe(true);
    const chunks = await c.chunk('word '.repeat(400), { chunkSize: 200, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((x) => x.text.length <= 200 && x.metadata === undefined)).toBe(true);
    expect(await c.chunk('   ', {})).toEqual([]);
  });
});

describe('PagedChunker', () => {
  const c = new PagedChunker();

  it('applies to PDFs by MIME type or extension only', () => {
    expect(c.supports({ mimeType: 'application/pdf' })).toBe(true);
    expect(c.supports({ filename: 'Report.PDF' })).toBe(true);
    expect(c.supports({ mimeType: 'text/plain', filename: 'a.txt' })).toBe(false);
  });

  it('keeps every chunk on one page and records the page number', async () => {
    const text = ['Page one talks about apples.', 'Page two talks about oranges.', 'Page three talks about pears.'].join(PAGE_BREAK);
    const chunks = await c.chunk(text, {});
    expect(chunks.map((x) => [x.metadata?.page, x.text])).toEqual([
      [1, 'Page one talks about apples.'],
      [2, 'Page two talks about oranges.'],
      [3, 'Page three talks about pears.'],
    ]);
  });

  it('long pages are split further but stay on their page', async () => {
    const text = ['intro', 'sentence about topic. '.repeat(100)].join(PAGE_BREAK);
    const chunks = await c.chunk(text, { chunkSize: 200, chunkOverlap: 20 });
    const second = chunks.filter((x) => x.metadata?.page === 2);
    expect(second.length).toBeGreaterThan(3);
    expect(chunks.filter((x) => x.metadata?.page === 1)).toHaveLength(1);
  });

  it('blank leading pages do not shift page numbers', async () => {
    const text = [BLANK_PAGE, BLANK_PAGE, 'Real content on page three.'].join(PAGE_BREAK);
    const chunks = await c.chunk(text, {});
    expect(chunks).toEqual([{ text: 'Real content on page three.', metadata: { page: 3 } }]);
  });

  it('falls back to plain chunking when the text has no page breaks', async () => {
    const chunks = await c.chunk('Just some text without pages.', {});
    expect(chunks).toEqual([{ text: 'Just some text without pages.' }]);
  });
});

describe('MarkdownChunker', () => {
  const c = new MarkdownChunker();

  it('applies to markdown and html by MIME type or extension', () => {
    expect(c.supports({ mimeType: 'text/markdown' })).toBe(true);
    expect(c.supports({ filename: 'notes.md' })).toBe(true);
    expect(c.supports({ filename: 'page.html' })).toBe(true);
    expect(c.supports({ mimeType: 'text/plain', filename: 'a.txt' })).toBe(false);
  });

  it('records the heading path of each section', async () => {
    const md = '# Guide\nIntro text.\n\n## Install\nRun the installer.\n\n### Linux\nUse the package manager.\n\n## Usage\nStart the app.';
    const chunks = await c.chunk(md, { chunkSize: 40, chunkOverlap: 0 });
    const byText = Object.fromEntries(chunks.map((x) => [x.text.split('\n').pop(), x.metadata?.section]));
    expect(byText['Run the installer.']).toBe('Guide > Install');
    expect(byText['Use the package manager.']).toBe('Guide > Install > Linux');
    expect(byText['Start the app.']).toBe('Guide > Usage');
  });

  it('packs consecutive small sections together instead of emitting tiny chunks', async () => {
    const md = '# A\none\n\n# B\ntwo\n\n# C\nthree';
    const chunks = await c.chunk(md, { chunkSize: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('# C');
    expect(chunks[0]!.metadata).toBeUndefined(); // unrelated sections share no heading path
  });

  it('a packed chunk is labelled with the heading path its sections share', async () => {
    const md = '# Guide\nintro\n\n## Install\nsteps\n\n## Usage\nrun';
    const chunks = await c.chunk(md, { chunkSize: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.metadata?.section).toBe('Guide');
  });

  it('splits an oversized section while keeping its heading path', async () => {
    const md = `# Big\n${'A sentence about things. '.repeat(100)}\n\n# Small\nshort`;
    const chunks = await c.chunk(md, { chunkSize: 200, chunkOverlap: 20 });
    expect(chunks.filter((x) => x.metadata?.section === 'Big').length).toBeGreaterThan(5);
    expect(chunks.at(-1)).toEqual({ text: '# Small\nshort', metadata: { section: 'Small' } });
  });

  it('does not treat "#" lines inside fenced code as headings', () => {
    const md = '# Real\ntext\n```sh\n# not a heading\necho hi\n```\nmore';
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.parts).toEqual(['Real']);
    expect(sections[0]!.text).toContain('# not a heading');
  });

  it('falls back to plain chunking when there are no headings', async () => {
    const chunks = await c.chunk('Plain paragraph without any headings.', {});
    expect(chunks).toEqual([{ text: 'Plain paragraph without any headings.' }]);
  });
});

describe('CsvChunker', () => {
  const c = new CsvChunker();
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `Row ${i + 1}: name: Person ${i + 1}; role: tester`).join('\n');

  it('applies to csv / tsv', () => {
    expect(c.supports({ mimeType: 'text/csv' })).toBe(true);
    expect(c.supports({ filename: 'x.tsv' })).toBe(true);
    expect(c.supports({ filename: 'x.json' })).toBe(false);
  });

  it('groups whole rows and records the row range', async () => {
    const chunks = await c.chunk(rows(10), { chunkSize: 120 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.metadata).toMatchObject({ rowStart: 1 });
    expect(chunks[0]!.metadata!.rowEnd).toBeGreaterThanOrEqual(2);
    expect(chunks.at(-1)!.metadata!.rowEnd).toBe(10);
    for (const ch of chunks) for (const line of ch.text.split('\n')) expect(line).toMatch(/^Row \d+: /); // no row cut in half
  });

  it('covers every row exactly once', async () => {
    const chunks = await c.chunk(rows(25), { chunkSize: 150 });
    const seen = chunks.flatMap((x) => x.text.split('\n').map((l) => Number(/^Row (\d+)/.exec(l)![1])));
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('splits a single enormous row but keeps its row number', async () => {
    const long = `Row 1: notes: ${'lorem ipsum '.repeat(100)}`;
    const chunks = await c.chunk(long, { chunkSize: 200, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((x) => x.metadata?.rowStart === 1)).toBe(true);
  });

  it('handles tabular text without row markers', async () => {
    const chunks = await c.chunk('a,b\n1,2\n3,4', {});
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.metadata).toBeUndefined();
  });
});

describe('ChunkerRegistry', () => {
  it('selects by type, earlier registrations win, and falls back to recursive', () => {
    const r = createDefaultChunkerRegistry();
    expect(r.select({ mimeType: 'application/pdf' }).name).toBe('paged');
    expect(r.select({ filename: 'a.md' }).name).toBe('markdown');
    expect(r.select({ filename: 'a.csv' }).name).toBe('tabular');
    expect(r.select({ filename: 'a.txt' }).name).toBe('recursive');
    expect(r.select({}).name).toBe('recursive');
  });

  it('accepts custom chunkers', () => {
    const custom = { name: 'custom', supports: () => true, chunk: async () => [] };
    expect(new ChunkerRegistry().register(custom).select({}).name).toBe('custom');
  });
});
