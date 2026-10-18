import { PrismaClient, type Document as PrismaDocument } from '@prisma/client';

export { PrismaClient };
import { errorMessage, healthReport } from '@agentic-ai/agent';
import { AbstractStorageAdapter, DuplicateContentError } from './AbstractStorageAdapter.js';
import type { DocumentPatch, DocumentStatus, IChatMessage, IChatSession, IDocument, IUser, NewDocument } from './types.js';

/** List/get queries never pull the (potentially large) extracted text. */
const DOC_SELECT = {
  id: true, userId: true, filename: true, mimeType: true, sourceUrl: true, status: true,
  errorMessage: true, chunksCount: true, createdAt: true, updatedAt: true,
} as const;

function toDocument(d: Omit<PrismaDocument, 'content' | 'contentHash'>): IDocument {
  return {
    id: d.id,
    userId: d.userId,
    filename: d.filename,
    mimeType: d.mimeType,
    sourceUrl: d.sourceUrl,
    status: d.status as DocumentStatus,
    errorMessage: d.errorMessage,
    chunksCount: d.chunksCount,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

const toSession = (s: { id: string; userId: string; title: string; createdAt: Date; updatedAt: Date }): IChatSession => ({
  id: s.id,
  userId: s.userId,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

export class PrismaStorageAdapter extends AbstractStorageAdapter {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    super();
    this.prisma = prisma ?? new PrismaClient();
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async checkHealth() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return healthReport('up');
    } catch (err) {
      return healthReport('down', errorMessage(err));
    }
  }

  async createUser(email: string, passwordHash: string, name: string): Promise<IUser> {
    const u = await this.prisma.user.create({ data: { email, passwordHash, name } });
    return { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt };
  }

  async findUserByEmail(email: string) {
    const u = await this.prisma.user.findUnique({ where: { email } });
    return u ? { id: u.id, email: u.email, name: u.name, passwordHash: u.passwordHash, createdAt: u.createdAt } : null;
  }

  async findUserById(id: string): Promise<IUser | null> {
    const u = await this.prisma.user.findUnique({ where: { id } });
    return u ? { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt } : null;
  }

  async createSession(userId: string, title?: string): Promise<IChatSession> {
    return toSession(await this.prisma.chatSession.create({ data: { userId, title: title || 'New Conversation' } }));
  }

  async listSessions(userId: string): Promise<IChatSession[]> {
    return (await this.prisma.chatSession.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } })).map(toSession);
  }

  async getSession(userId: string, sessionId: string): Promise<IChatSession | null> {
    const s = await this.prisma.chatSession.findFirst({ where: { id: sessionId, userId } });
    return s ? toSession(s) : null;
  }

  async renameSession(userId: string, sessionId: string, title: string): Promise<boolean> {
    const r = await this.prisma.chatSession.updateMany({ where: { id: sessionId, userId }, data: { title } });
    return r.count > 0;
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const r = await this.prisma.chatSession.deleteMany({ where: { id: sessionId, userId } });
    return r.count > 0;
  }

  async saveMessage(userId: string, sessionId: string, sender: 'user' | 'agent', content: string, metadata?: unknown): Promise<IChatMessage | null> {
    const session = await this.prisma.chatSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } });
    if (!session) return null;
    const [message] = await this.prisma.$transaction([
      this.prisma.chatMessage.create({ data: { sessionId, sender, content, metadata: metadata ? JSON.stringify(metadata) : null } }),
      this.prisma.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } }),
    ]);
    return { id: message.id, sessionId, sender: message.sender as 'user' | 'agent', content: message.content, metadata: message.metadata, createdAt: message.createdAt };
  }

  async getMessages(userId: string, sessionId: string, options: { limit?: number } = {}): Promise<IChatMessage[] | null> {
    const session = await this.prisma.chatSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } });
    if (!session) return null;
    const rows = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: options.limit ? 'desc' : 'asc' },
      take: options.limit,
    });
    const ordered = options.limit ? rows.reverse() : rows;
    return ordered.map((m) => ({ id: m.id, sessionId: m.sessionId, sender: m.sender as 'user' | 'agent', content: m.content, metadata: m.metadata, createdAt: m.createdAt }));
  }

  async createDocument(userId: string, doc: NewDocument): Promise<IDocument> {
    try {
      return toDocument(
        await this.prisma.document.create({
          data: { userId, filename: doc.filename, mimeType: doc.mimeType, sourceUrl: doc.sourceUrl ?? null, content: doc.content ?? null, contentHash: doc.contentHash ?? null, status: 'processing' },
          select: DOC_SELECT,
        }),
      );
    } catch (err: any) {
      if (err?.code === 'P2002') throw new DuplicateContentError(); // unique (userId, contentHash)
      throw err;
    }
  }

  async findDocumentByContentHash(userId: string, contentHash: string): Promise<IDocument | null> {
    const d = await this.prisma.document.findFirst({ where: { userId, contentHash }, select: DOC_SELECT });
    return d ? toDocument(d) : null;
  }

  async updateDocument(userId: string, documentId: string, patch: DocumentPatch): Promise<IDocument | null> {
    const r = await this.prisma.document.updateMany({ where: { id: documentId, userId }, data: patch });
    return r.count > 0 ? this.getDocument(userId, documentId) : null;
  }

  async getDocument(userId: string, documentId: string): Promise<IDocument | null> {
    const d = await this.prisma.document.findFirst({ where: { id: documentId, userId }, select: DOC_SELECT });
    return d ? toDocument(d) : null;
  }

  async getDocumentContent(userId: string, documentId: string): Promise<string | null> {
    const d = await this.prisma.document.findFirst({ where: { id: documentId, userId }, select: { content: true } });
    return d?.content ?? null;
  }

  async listDocuments(userId: string): Promise<IDocument[]> {
    return (await this.prisma.document.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: DOC_SELECT })).map(toDocument);
  }

  async countDocuments(userId: string): Promise<number> {
    return this.prisma.document.count({ where: { userId } });
  }

  async deleteDocument(userId: string, documentId: string): Promise<boolean> {
    const r = await this.prisma.document.deleteMany({ where: { id: documentId, userId } });
    return r.count > 0;
  }
}
