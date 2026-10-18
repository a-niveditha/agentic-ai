# rag/loaders

> Parent: [agent/src/rag](../README.md)

Turns the raw bytes of an uploaded file into plain text for ingestion. One loader per format; a registry picks the right one and verifies the bytes really are that format.

## Interface contract: `DocumentLoader` ([types.ts](types.ts))

```ts
interface LoaderInput { buffer: Buffer; filename: string; mimeType?: string }
interface LoadedDocument { text: string; title?: string; metadata?: Record<string, string | number | boolean> }

interface DocumentLoader {
  readonly name: string;
  readonly extensions: readonly string[];   // lowercase, no dot
  readonly mimeTypes: readonly string[];
  matchesContent(buffer: Buffer): boolean;  // cheap sniff: magic number / not binary
  load(input: LoaderInput): Promise<LoadedDocument>;
}
```

Failures are always `LoaderError` with a `code`:

| code | meaning | backend HTTP |
|---|---|---|
| `unsupported` | no loader for this extension / MIME | 415 |
| `mismatch` | bytes do not match the claimed type (PDF renamed `.txt`, ELF as `.md`) | 422 |
| `empty` | no extractable text | 422 |
| `too_large` | over the loader's byte limit, or a zip bomb | 413 |
| `corrupt` | the parser could not read it | 422 |

## Writing a loader

Extend `BaseDocumentLoader` ([BaseDocumentLoader.ts](BaseDocumentLoader.ts)) and implement `extract()`; set `name`, `extensions`, `mimeTypes`. The base class already does the empty check, the size limit (default 10 MB), the content sniff (rejects binary for text formats; override `matchesContent` with a magic-number check for binary formats), wraps parser exceptions as `corrupt`, and normalises the text (newlines, NULs, blank-line runs). Register it with `registry.register(new MyLoader())`.

## `LoaderRegistry` ([LoaderRegistry.ts](LoaderRegistry.ts))

- `resolve(input)`: picks by extension; a specific MIME type is used only when there is no extension (generic `application/octet-stream` is ignored); then runs `matchesContent`.
- `load(input)`: resolve + load, returns the document plus the loader `name`.
- `supportedExtensions()`; `createDefaultLoaderRegistry({ maxBytes })` registers all built-ins.

## Built-in loaders ([builtinLoaders.ts](builtinLoaders.ts))

| Loader | Extensions | Notes |
|---|---|---|
| `TextLoader` | txt, log, text | |
| `MarkdownLoader` | md, markdown | |
| `PdfLoader` | pdf | `%PDF` magic check; max 300 pages by default; emits a form feed (`PAGE_BREAK`) between pages and `BLANK_PAGE` for pages without text, so ingestion can record page numbers; a PDF with no text at all (scanned) fails as `empty` |
| `DocxLoader` | docx | zip signature check + `assertZipIsSafe` before inflating |
| `HtmlLoader` | html, htm | Readability then Markdown ([htmlToMarkdown.ts](htmlToMarkdown.ts)) |
| `CsvLoader` | csv, tsv | max 5 000 rows by default |
| `JsonLoader` | json | |

## Zip-bomb guard ([zipGuard.ts](zipGuard.ts))

`assertZipIsSafe(buffer, limits?)` reads only the zip central directory (no decompression) and throws `LoaderError('too_large')` for more than 2 000 entries, more than 60 MB uncompressed, or a compression ratio above 200.

## Tests

Covered by [`__tests__/loaders.unit.test.ts`](__tests__/loaders.unit.test.ts); hostile inputs by [tests/security/hardening.sec.test.ts](../../../../tests/security/hardening.sec.test.ts).
