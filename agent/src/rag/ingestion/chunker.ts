import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface ChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 150;

export async function chunkTextToDocuments(
  text: string,
  metadata: Record<string, any> = {},
  options: ChunkOptions = {},
): Promise<Document[]> {
  if (!text || text.trim().length === 0) return [];
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = Math.min(options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP, Math.floor(chunkSize / 2));
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ['\n\n', '\n', '. ', ' ', ''],
  });
  const docs = await splitter.createDocuments([text], [metadata]);
  return docs.filter((d) => d.pageContent.trim().length > 0);
}
