export interface IUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface IChatSession {
  id: string;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IChatMessage {
  id: string;
  sessionId: string;
  sender: 'user' | 'agent';
  content: string;
  metadata?: string | null;
  createdAt: Date;
}

export type DocumentStatus = 'processing' | 'ready' | 'failed';

export interface IDocument {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  sourceUrl: string | null;
  status: DocumentStatus;
  errorMessage: string | null;
  chunksCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewDocument {
  filename: string;
  mimeType: string;
  sourceUrl?: string | null;
  content?: string | null;
  /** sha256 of `content`; at most one document per user may have a given hash. */
  contentHash?: string | null;
}

export interface DocumentPatch {
  status?: DocumentStatus;
  errorMessage?: string | null;
  chunksCount?: number;
  content?: string | null;
}
