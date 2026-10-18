import { beforeEach, describe, expect, it } from 'bun:test';
import { DuplicateContentError, type AbstractStorageAdapter } from '../AbstractStorageAdapter.js';

/**
 * Behavioral contract every storage adapter must satisfy, most importantly: data is only reachable by its owner.
 * Run against the in-memory adapter (unit) and Prisma/SQLite (integration).
 */
export function describeStorageContract(name: string, make: () => Promise<{ storage: AbstractStorageAdapter; cleanup?: () => Promise<void> }>) {
  describe(`${name}: storage contract`, () => {
    let s: AbstractStorageAdapter;
    let alice: string;
    let bob: string;
    let cleanup: (() => Promise<void>) | undefined;
    let counter = 0;

    beforeEach(async () => {
      if (cleanup) await cleanup();
      ({ storage: s, cleanup } = await make());
      const n = ++counter;
      alice = (await s.createUser(`alice${n}@test.dev`, 'hash-a', 'Alice')).id;
      bob = (await s.createUser(`bob${n}@test.dev`, 'hash-b', 'Bob')).id;
    });

    describe('users', () => {
      it('creates, finds by email and id; never exposes the hash via findUserById', async () => {
        const created = await s.createUser('carol@test.dev', 'secret-hash', 'Carol');
        expect(created).toMatchObject({ email: 'carol@test.dev', name: 'Carol' });
        expect(created).not.toHaveProperty('passwordHash');
        expect((await s.findUserByEmail('carol@test.dev'))!.passwordHash).toBe('secret-hash');
        const byId = await s.findUserById(created.id);
        expect(byId).toMatchObject({ id: created.id, email: 'carol@test.dev' });
        expect(byId).not.toHaveProperty('passwordHash');
      });
      it('returns null for unknown users', async () => {
        expect(await s.findUserByEmail('nobody@test.dev')).toBeNull();
        expect(await s.findUserById('00000000-0000-4000-8000-000000000000')).toBeNull();
      });
      it('enforces unique emails', async () => {
        await s.createUser('dup@test.dev', 'h', 'D1');
        await expect(s.createUser('dup@test.dev', 'h', 'D2')).rejects.toThrow();
      });
    });

    describe('sessions & messages', () => {
      it('creates sessions with a default title and lists only the owner\'s, newest activity first', async () => {
        const a1 = await s.createSession(alice);
        const a2 = await s.createSession(alice, 'Planning');
        await s.createSession(bob, 'Bob chat');
        expect(a1.title).toBe('New Conversation');
        await new Promise((r) => setTimeout(r, 10));
        await s.saveMessage(alice, a1.id, 'user', 'bump');
        const list = await s.listSessions(alice);
        expect(list.map((x) => x.id)).toEqual([a1.id, a2.id]);
        expect(list.every((x) => x.userId === alice)).toBe(true);
      });

      it('OWNERSHIP: other users cannot read, rename, delete or post to a session (indistinguishable from missing)', async () => {
        const sess = await s.createSession(alice, 'Private');
        await s.saveMessage(alice, sess.id, 'user', 'secret plan');
        expect(await s.getSession(bob, sess.id)).toBeNull();
        expect(await s.renameSession(bob, sess.id, 'hacked')).toBe(false);
        expect(await s.getMessages(bob, sess.id)).toBeNull();
        expect(await s.saveMessage(bob, sess.id, 'user', 'injected')).toBeNull();
        expect(await s.deleteSession(bob, sess.id)).toBe(false);
        // …and none of that changed anything
        expect((await s.getSession(alice, sess.id))!.title).toBe('Private');
        expect((await s.getMessages(alice, sess.id))!.map((m) => m.content)).toEqual(['secret plan']);
      });

      it('renames and deletes (with messages) for the owner', async () => {
        const sess = await s.createSession(alice);
        await s.saveMessage(alice, sess.id, 'user', 'hi');
        expect(await s.renameSession(alice, sess.id, 'Renamed')).toBe(true);
        expect((await s.getSession(alice, sess.id))!.title).toBe('Renamed');
        expect(await s.deleteSession(alice, sess.id)).toBe(true);
        expect(await s.getSession(alice, sess.id)).toBeNull();
        expect(await s.getMessages(alice, sess.id)).toBeNull();
        expect(await s.deleteSession(alice, sess.id)).toBe(false);
      });

      it('stores messages in order with JSON metadata; limit keeps the most recent N (oldest-first)', async () => {
        const sess = await s.createSession(alice);
        for (let i = 0; i < 5; i++) {
          await s.saveMessage(alice, sess.id, i % 2 === 0 ? 'user' : 'agent', `m${i}`, i === 4 ? { citations: [{ title: 'T' }] } : undefined);
          await new Promise((r) => setTimeout(r, 3));
        }
        const all = (await s.getMessages(alice, sess.id))!;
        expect(all.map((m) => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
        expect(all.map((m) => m.sender)).toEqual(['user', 'agent', 'user', 'agent', 'user']);
        expect(JSON.parse(all[4]!.metadata!)).toEqual({ citations: [{ title: 'T' }] });
        expect(all[0]!.metadata).toBeNull();
        expect((await s.getMessages(alice, sess.id, { limit: 2 }))!.map((m) => m.content)).toEqual(['m3', 'm4']);
      });

      it('saving a message touches the session ordering', async () => {
        const first = await s.createSession(alice, 'first');
        await new Promise((r) => setTimeout(r, 10));
        const second = await s.createSession(alice, 'second');
        expect((await s.listSessions(alice))[0]!.id).toBe(second.id);
        await new Promise((r) => setTimeout(r, 10));
        await s.saveMessage(alice, first.id, 'user', 'bump');
        expect((await s.listSessions(alice))[0]!.id).toBe(first.id);
      });
    });

    describe('documents', () => {
      const newDoc = (name = 'a.txt', extra: any = {}) => ({ filename: name, mimeType: 'text/plain', content: 'full extracted text', ...extra });

      it('creates in processing state; content is never part of the public record', async () => {
        const d = await s.createDocument(alice, newDoc('notes.txt', { sourceUrl: 'https://x.test/n' }));
        expect(d).toMatchObject({ userId: alice, filename: 'notes.txt', status: 'processing', chunksCount: 0, sourceUrl: 'https://x.test/n', errorMessage: null });
        expect(d).not.toHaveProperty('content');
        expect(await s.getDocumentContent(alice, d.id)).toBe('full extracted text');
      });

      it('updates status, chunk count and error; list/get never leak content', async () => {
        const d = await s.createDocument(alice, newDoc());
        const ready = await s.updateDocument(alice, d.id, { status: 'ready', chunksCount: 4 });
        expect(ready).toMatchObject({ status: 'ready', chunksCount: 4 });
        const failed = await s.updateDocument(alice, d.id, { status: 'failed', errorMessage: 'embedding down' });
        expect(failed).toMatchObject({ status: 'failed', errorMessage: 'embedding down' });
        for (const doc of [...(await s.listDocuments(alice)), (await s.getDocument(alice, d.id))!]) expect(doc).not.toHaveProperty('content');
      });

      it('CONTENT HASH: one document per user and hash; other users and null hashes are unaffected; the hash is never exposed', async () => {
        const d = await s.createDocument(alice, { ...newDoc('a.txt'), contentHash: 'hash-1' });
        await expect(s.createDocument(alice, { ...newDoc('copy.txt'), contentHash: 'hash-1' })).rejects.toBeInstanceOf(DuplicateContentError);
        expect(await s.countDocuments(alice)).toBe(1);
        await s.createDocument(bob, { ...newDoc('b.txt'), contentHash: 'hash-1' }); // another user may hold identical content
        await s.createDocument(alice, newDoc('x.txt'));
        await s.createDocument(alice, newDoc('y.txt')); // documents without a hash never collide
        expect((await s.findDocumentByContentHash(alice, 'hash-1'))!.id).toBe(d.id);
        expect(await s.findDocumentByContentHash(alice, 'nope')).toBeNull();
        expect((await s.findDocumentByContentHash(bob, 'hash-1'))!.id).not.toBe(d.id);
        expect(await s.deleteDocument(alice, d.id)).toBe(true);
        expect(await s.findDocumentByContentHash(alice, 'hash-1')).toBeNull(); // deleting frees the hash
        expect(await s.createDocument(alice, { ...newDoc('again.txt'), contentHash: 'hash-1' })).toBeDefined();
        for (const doc of await s.listDocuments(alice)) expect(doc).not.toHaveProperty('contentHash');
      });

      it('OWNERSHIP: other users cannot get, read content, update or delete a document', async () => {
        const d = await s.createDocument(alice, newDoc('private.txt'));
        expect(await s.getDocument(bob, d.id)).toBeNull();
        expect(await s.getDocumentContent(bob, d.id)).toBeNull();
        expect(await s.updateDocument(bob, d.id, { status: 'failed' })).toBeNull();
        expect(await s.deleteDocument(bob, d.id)).toBe(false);
        expect(await s.listDocuments(bob)).toEqual([]);
        expect((await s.getDocument(alice, d.id))!.status).toBe('processing');
        expect(await s.countDocuments(bob)).toBe(0);
      });

      it('lists newest first, counts and deletes', async () => {
        const d1 = await s.createDocument(alice, newDoc('one.txt'));
        await new Promise((r) => setTimeout(r, 10));
        const d2 = await s.createDocument(alice, newDoc('two.txt'));
        expect((await s.listDocuments(alice)).map((d) => d.id)).toEqual([d2.id, d1.id]);
        expect(await s.countDocuments(alice)).toBe(2);
        expect(await s.deleteDocument(alice, d1.id)).toBe(true);
        expect(await s.deleteDocument(alice, d1.id)).toBe(false);
        expect(await s.countDocuments(alice)).toBe(1);
      });
    });

    it('reports healthy', async () => {
      expect((await s.checkHealth()).status).toBe('up');
    });
  });
}
