# rag/ingestion/chunkers

> Parent: [rag/ingestion](../README.md)

Chunking strategies. The right way to cut a document depends on its type, so ingestion asks a registry for a strategy by MIME type and file extension.

## Interface contract: `Chunker` ([types.ts](types.ts))

```ts
interface Chunker {
  readonly name: string;                                   // reported in IngestionResult.chunker
  supports(context: { mimeType?: string; filename?: string }): boolean;
  chunk(text: string, options: { chunkSize?: number; chunkOverlap?: number }): Promise<TextChunk[]>;
}
interface TextChunk { text: string; metadata?: { page?: number; section?: string; rowStart?: number; rowEnd?: number } }
```

Implementer obligations: chunks are self-contained and roughly at most `chunkSize` characters; never return empty chunks; put a location in `metadata` only when the format really has one (it becomes part of the chunk id, citations and the model's source labels); never throw on odd input, fall back to plain splitting.

## Strategies

| Chunker (`name`) | Applies to | Behaviour |
|---|---|---|
| [`PagedChunker`](PagedChunker.ts) (`paged`) | PDF | Splits on the loader's page breaks; a chunk never spans two pages and records `page`. Blank pages keep their number. Text without page breaks falls back to recursive. |
| [`MarkdownChunker`](MarkdownChunker.ts) (`markdown`) | md, markdown, html (converted to Markdown by the loader) | Splits along headings (ignoring `#` inside code fences) and records the heading path `A > B > C` as `section`. Small neighbouring sections are packed together and labelled with the heading path they share (none if unrelated); oversized sections are split further but keep their path. |
| [`CsvChunker`](CsvChunker.ts) (`tabular`) | csv, tsv | Groups whole rows (never cuts a row) and records `rowStart` / `rowEnd`. Relies on the CSV loader writing each row as `Row N: column: value; …`. |
| [`RecursiveChunker`](RecursiveChunker.ts) (`recursive`) | anything (the fallback) | Paragraph → line → sentence → word splitting with overlap. |

## `ChunkerRegistry` ([ChunkerRegistry.ts](ChunkerRegistry.ts))

`register(chunker)` (earlier registrations win, so register specific formats first), `select(context)` returns the first chunker that supports the document, else the fallback. `createDefaultChunkerRegistry()` registers paged, markdown and tabular.

## Adding a chunker

Implement `Chunker`, then either pass it directly (`ingestDocument(…, { chunker })`) or add it to a registry and pass the registry. Add unit tests next to [`../__tests__/chunkers.unit.test.ts`](../__tests__/chunkers.unit.test.ts).
