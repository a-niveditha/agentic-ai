import { randomUUID } from 'node:crypto';
import { healthReport } from '@agentic-ai/agent';
import { AbstractStorageAdapter, DuplicateContentError } from './AbstractStorageAdapter.js';
import type { DocumentPatch, IChatMessage, IChatSession, IDocument, IUser, NewDocument } from './types.js';

type StoredDoc = IDocument & { content: string | null; contentHash: string | null };

/** Non-persistent storage for unit tests and quick demos. Same ownership rules as the Prisma adapter. */
export class InMemoryStorageAdapter extends AbstractStorageAdapter {
  private users = new Map<string, IUser & { passwordHash: string }>();
  private sessions = new Map<string, IChatSession>();
  private messages = new Map<string, IChatMessage[]>();
  private documents = new Map<string, StoredDoc>();
  /** Tests flip this to simulate a database outage. */
  failWith?: Error;

  private guard() {
    if (this.failWith) throw this.failWith;
  }

  async checkHealth() {
    return this.failWith ? healthReport('down', this.failWith.message) : healthReport('up', 'in-memory');
  }

  async createUser(email: string, passwordHash: string, name: string): Promise<IUser> {
    this.guard();
    if ([...this.users.values()].some((u) => u.email === email)) throw Object.assign(new Error('Unique constraint failed on email'), { code: 'P2002' });
    const user = { id: randomUUID(), email, passwordHash, name, createdAt: new Date() };
    this.users.set(user.id, user);
    return { id: user.id, email, name, createdAt: user.createdAt };
  }

  async findUserByEmail(email: string) {
    this.guard();
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async findUserById(id: string): Promise<IUser | null> {
    this.guard();
    const u = this.users.get(id);
    return u ? { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt } : null;
  }

  async createSession(userId: string, title?: string): Promise<IChatSession> {
    this.guard();
    const now = new Date();
    const s: IChatSession = { id: randomUUID(), userId, title: title || 'New Conversation', createdAt: now, updatedAt: now };
    this.sessions.set(s.id, s);
    this.messages.set(s.id, []);
    return s;
  }

  async listSessions(userId: string): Promise<IChatSession[]> {
    this.guard();
    return [...this.sessions.values()].filter((s) => s.userId === userId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async getSession(userId: string, sessionId: string): Promise<IChatSession | null> {
    this.guard();
    const s = this.sessions.get(sessionId);
    return s && s.userId === userId ? s : null;
  }

  async renameSession(userId: string, sessionId: string, title: string): Promise<boolean> {
    const s = await this.getSession(userId, sessionId);
    if (!s) return false;
    s.title = title;
    s.updatedAt = new Date();
    return true;
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const s = await this.getSession(userId, sessionId);
    if (!s) return false;
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    return true;
  }

  async saveMessage(userId: string, sessionId: string, sender: 'user' | 'agent', content: string, metadata?: unknown): Promise<IChatMessage | null> {
    const s = await this.getSession(userId, sessionId);
    if (!s) return null;
    const msg: IChatMessage = { id: randomUUID(), sessionId, sender, content, metadata: metadata ? JSON.stringify(metadata) : null, createdAt: new Date() };
    this.messages.get(sessionId)!.push(msg);
    s.updatedAt = new Date();
    return msg;
  }

  async getMessages(userId: string, sessionId: string, options: { limit?: number } = {}): Promise<IChatMessage[] | null> {
    const s = await this.getSession(userId, sessionId);
    if (!s) return null;
    const all = this.messages.get(sessionId) ?? [];
    return options.limit ? all.slice(-options.limit) : [...all];
  }

  async createDocument(userId: string, doc: NewDocument): Promise<IDocument> {
    this.guard();
    if (doc.contentHash && [...this.documents.values()].some((d) => d.userId === userId && d.contentHash === doc.contentHash)) throw new DuplicateContentError();
    const now = new Date();
    const stored: StoredDoc = {
      id: randomUUID(),
      userId,
      filename: doc.filename,
      mimeType: doc.mimeType,
      sourceUrl: doc.sourceUrl ?? null,
      status: 'processing',
      errorMessage: null,
      chunksCount: 0,
      createdAt: now,
      updatedAt: now,
      content: doc.content ?? null,
      contentHash: doc.contentHash ?? null,
    };
    this.documents.set(stored.id, stored);
    return this.publicDoc(stored);
  }

  private publicDoc({ content: _c, contentHash: _h, ...doc }: StoredDoc): IDocument {
    return { ...doc };
  }

  async findDocumentByContentHash(userId: string, contentHash: string): Promise<IDocument | null> {
    this.guard();
    const d = [...this.documents.values()].find((x) => x.userId === userId && x.contentHash === contentHash);
    return d ? this.publicDoc(d) : null;
  }

  async updateDocument(userId: string, documentId: string, patch: DocumentPatch): Promise<IDocument | null> {
    this.guard();
    const d = this.documents.get(documentId);
    if (!d || d.userId !== userId) return null;
    if (patch.status !== undefined) d.status = patch.status;
    if (patch.errorMessage !== undefined) d.errorMessage = patch.errorMessage;
    if (patch.chunksCount !== undefined) d.chunksCount = patch.chunksCount;
    if (patch.content !== undefined) d.content = patch.content;
    d.updatedAt = new Date();
    return this.publicDoc(d);
  }

  async getDocument(userId: string, documentId: string): Promise<IDocument | null> {
    this.guard();
    const d = this.documents.get(documentId);
    return d && d.userId === userId ? this.publicDoc(d) : null;
  }

  async getDocumentContent(userId: string, documentId: string): Promise<string | null> {
    this.guard();
    const d = this.documents.get(documentId);
    return d && d.userId === userId ? d.content : null;
  }

  async listDocuments(userId: string): Promise<IDocument[]> {
    this.guard();
    return [...this.documents.values()].filter((d) => d.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((d) => this.publicDoc(d));
  }

  async countDocuments(userId: string): Promise<number> {
    this.guard();
    return [...this.documents.values()].filter((d) => d.userId === userId).length;
  }

  async deleteDocument(userId: string, documentId: string): Promise<boolean> {
    this.guard();
    const d = this.documents.get(documentId);
    if (!d || d.userId !== userId) return false;
    this.documents.delete(documentId);
    return true;
  }
}
