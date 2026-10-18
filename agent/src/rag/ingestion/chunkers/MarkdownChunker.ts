import { DEFAULT_CHUNK_SIZE, type ChunkOptions } from '../chunker.js';
import { RecursiveChunker } from './RecursiveChunker.js';
import { extensionOf, mimeBase, type ChunkContext, type Chunker, type TextChunk } from './types.js';

const MARKDOWN_TYPES = new Set(['text/markdown', 'text/x-markdown', 'text/html', 'application/xhtml+xml']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'html', 'htm']);
const MAX_SECTION_LABEL = 200;

interface Section {
  /** Heading titles from the top level down to this section (empty before the first heading). */
  parts: string[];
  text: string;
  /** True when the section is only a heading line with nothing under it. */
  headingOnly?: boolean;
}

function label(parts: string[]): string | undefined {
  return parts.length ? parts.join(' > ').slice(0, MAX_SECTION_LABEL) : undefined;
}

/** Longest shared heading prefix: the honest label for a chunk that packs several sections. */
function commonParts(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) out.push(a[i]!);
  return out;
}

/** Splits Markdown (and HTML, which the loader converts to Markdown) along headings and records the heading path. */
export class MarkdownChunker implements Chunker {
  readonly name = 'markdown';
  private readonly recursive = new RecursiveChunker();

  supports({ mimeType, filename }: ChunkContext): boolean {
    return MARKDOWN_TYPES.has(mimeBase(mimeType)) || MARKDOWN_EXTENSIONS.has(extensionOf(filename));
  }

  async chunk(text: string, options: ChunkOptions): Promise<TextChunk[]> {
    const size = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const sections = splitSections(text);
    if (sections.length <= 1 && !sections[0]?.parts.length) return this.recursive.chunk(text, options);

    const out: TextChunk[] = [];
    // Pack consecutive small sections together so tiny sections do not become tiny chunks. A packed chunk is
    // labelled with the heading path its sections share (none if they are unrelated), never with a wrong one.
    let buffer: (Section & { labelParts?: string[] }) | undefined;
    const flush = () => {
      const section = buffer && label(buffer.labelParts ?? buffer.parts);
      if (buffer?.text.trim()) out.push({ text: buffer.text.trim(), metadata: section ? { section } : undefined });
      buffer = undefined;
    };
    for (const section of sections) {
      if (!section.text.trim()) continue;
      if (section.text.length > size) {
        flush();
        const sectionLabel = label(section.parts);
        out.push(...(await this.recursive.chunk(section.text, options, sectionLabel ? { section: sectionLabel } : undefined)));
        continue;
      }
      if (buffer && buffer.text.length + 2 + section.text.length <= size) {
        buffer.text += `\n\n${section.text}`;
        // A bare heading owns no text, so it must not dilute the label of the content packed after it.
        if (!section.headingOnly) buffer.labelParts = buffer.labelParts ? commonParts(buffer.labelParts, section.parts) : [...section.parts];
      } else {
        flush();
        buffer = { parts: [...section.parts], text: section.text, labelParts: section.headingOnly ? undefined : [...section.parts] };
      }
    }
    flush();
    return out;
  }
}

/** Splits on ATX headings (`#`..`######`), ignoring `#` lines inside fenced code blocks. */
export function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { parts: [], text: '' };
  let fence: string | undefined;

  const push = () => {
    if (current.text.trim()) sections.push(current);
  };

  for (const line of text.split('\n')) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) fence = fence === fenceMatch[1] ? undefined : fence ?? fenceMatch[1];
    const heading = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      push();
      const level = heading[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: heading[2]! });
      current = { parts: stack.map((h) => h.title), text: `${line}\n` };
    } else {
      current.text += `${line}\n`;
    }
  }
  push();
  return sections.map((s) => {
    const text = s.text.trim();
    return { ...s, text, headingOnly: text.split('\n').length === 1 && /^#{1,6}\s/.test(text) };
  });
}
