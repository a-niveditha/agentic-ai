export type DocumentStatus = "processing" | "ready" | "failed";

export type KnowledgeDocument = {
  id: string;
  filename: string;
  mimeType: string;
  sourceUrl: string | null;
  status: DocumentStatus;
  errorMessage: string | null;
  chunksCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentList = {
  documents: KnowledgeDocument[];
  supportedExtensions: string[];
};

export type DocumentPayload = { document: KnowledgeDocument };
