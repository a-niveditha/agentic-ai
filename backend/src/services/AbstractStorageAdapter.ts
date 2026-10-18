import type { HealthCheckable } from '@agentic-ai/agent';
import type { DocumentPatch, IChatMessage, IChatSession, IDocument, IUser, NewDocument } from './types.js';

/** Thrown by `createDocument` when the user already has a document with the same `contentHash`. */
export class DuplicateContentError extends Error {
  constructor() {
    super('A document with identical content already exists.');
    this.name = 'DuplicateContentError';
  }
}

/**
 * Persistence port. Every method that touches user data takes the owning `userId` and MUST enforce it
 * inside the query itself, so a caller cannot reach another user's rows by guessing an id (a foreign
 * id is indistinguishable from a missing one: `null` / `false`).
 */
export abstract class AbstractStorageAdapter implements HealthCheckable {
  readonly componentName: string = 'database';
  abstract checkHealth(): ReturnType<HealthCheckable['checkHealth']>;

  abstract createUser(email: string, passwordHash: string, name: string): Promise<IUser>;
  abstract findUserByEmail(email: string): Promise<(IUser & { passwordHash: string }) | null>;
  abstract findUserById(id: string): Promise<IUser | null>;

  abstract createSession(userId: string, title?: string): Promise<IChatSession>;
  abstract listSessions(userId: string): Promise<IChatSession[]>;
  abstract getSession(userId: string, sessionId: string): Promise<IChatSession | null>;
  abstract renameSession(userId: string, sessionId: string, title: string): Promise<boolean>;
  abstract deleteSession(userId: string, sessionId: string): Promise<boolean>;

  /** Returns null when the session does not belong to `userId`. */
  abstract saveMessage(
    userId: string,
    sessionId: string,
    sender: 'user' | 'agent',
    content: string,
    metadata?: unknown,
  ): Promise<IChatMessage | null>;
  /** Oldest-first; `limit` keeps the most recent N. Returns null when the session is not owned by `userId`. */
  abstract getMessages(userId: string, sessionId: string, options?: { limit?: number }): Promise<IChatMessage[] | null>;

  /** Throws `DuplicateContentError` if `doc.contentHash` is set and the user already has a document with it. */
  abstract createDocument(userId: string, doc: NewDocument): Promise<IDocument>;
  abstract findDocumentByContentHash(userId: string, contentHash: string): Promise<IDocument | null>;
  abstract updateDocument(userId: string, documentId: string, patch: DocumentPatch): Promise<IDocument | null>;
  abstract getDocument(userId: string, documentId: string): Promise<IDocument | null>;
  /** Internal only: the extracted text kept for retry / re-embedding. */
  abstract getDocumentContent(userId: string, documentId: string): Promise<string | null>;
  abstract listDocuments(userId: string): Promise<IDocument[]>;
  abstract countDocuments(userId: string): Promise<number>;
  abstract deleteDocument(userId: string, documentId: string): Promise<boolean>;
}
