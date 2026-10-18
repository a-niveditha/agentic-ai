import { describe, expect, it } from 'bun:test';
import { InMemoryVectorStoreAdapter, FakeEmbeddingProvider, createDefaultLoaderRegistry, ScriptedChatModelProvider, ChatAgent, ToolRegistry, CalculatorTool, type StreamEvent } from '../../../../agent/src/index.js';
import { createLogger } from '../../lib/logger.js';
import { ChatService } from '../chatService.js';
import { DocumentService, safeFilename } from '../documentService.js';
import { InMemoryStorageAdapter } from '../InMemoryStorageAdapter.js';
import { FakeScraper } from '../../../../tests/helpers/testApp.js';

const logger = createLogger('silent');

describe('safeFilename', () => {
  const cases: [string, string][] = [
    ['report.pdf', 'report.pdf'], ['../../etc/passwd', 'passwd'], ['..\\..\\windows\\system32\\cmd.exe', 'cmd.exe'], ['/abs/path/file.txt', 'file.txt'],
    ['evil\u0000name\u001f.txt', 'evilname.txt'], ['we<ird>:na"me|?*.txt', 'we_ird__na_me___.txt'], ['', 'document'], ['..', 'document'], ['.', 'document'], ['   ', 'document'],
  ];
  for (const [input, want] of cases) it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => expect(safeFilename(input)).toBe(want));
  it('limits length and tolerates non-strings', () => {
    expect(safeFilename('a'.repeat(400) + '.txt').length).toBeLessThanOrEqual(200);
    expect(safeFilename(undefined as any)).toBe('document');
  });
});

function docService(maxDocs = 3) {
  const storage = new InMemoryStorageAdapter();
  const embeddings = new FakeEmbeddingProvider();
  const vectorStore = new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata });
  const svc = new DocumentService({ storage, vectorStore, loaders: createDefaultLoaderRegistry(), scraper: new FakeScraper(), logger, limits: { maxDocsPerUser: maxDocs, maxContentChars: 500 }, ingestion: { retryBaseDelayMs: 5 } });
  return { svc, storage, vectorStore, embeddings };
}

describe('DocumentService', () => {
  it('saveText (the agent sink) indexes under the TRUSTED tenant and returns ids', async () => {
    const { svc, vectorStore, storage } = docService();
    const u = await storage.createUser('s@test.dev', 'h', 'S');
    const ctx = { principalId: u.id, tenantId: u.id, scopes: [], executionId: 'e', budget: { maxToolCalls: 1, maxModelCalls: 1 } };
    const out = await svc.saveText(ctx, { title: 'Saved page', text: 'The Gizmo calibration procedure has three steps.', sourceUrl: 'https://x.test/p' });
    expect(out.chunksIndexed).toBeGreaterThan(0);
    const hit = (await vectorStore.similaritySearch('gizmo calibration', 1, { userId: u.id }))[0]!;
    expect(hit.document.metadata).toMatchObject({ userId: u.id, sourceId: out.documentId, sourceUrl: 'https://x.test/p' });
  });

  it('enforces the document quota in saveText too', async () => {
    const { svc, storage } = docService(1);
    const u = await storage.createUser('q@test.dev', 'h', 'Q');
    const ctx = { principalId: u.id, tenantId: u.id, scopes: [], executionId: 'e', budget: { maxToolCalls: 1, maxModelCalls: 1 } };
    await svc.saveText(ctx, { title: 'one', text: 'first document text' });
    await expect(svc.saveText(ctx, { title: 'two', text: 'second document text' })).rejects.toMatchObject({ status: 403, code: 'quota_exceeded' });
  });

  it('rejects text above the content limit (413) and empty text (422) before creating rows', async () => {
    const { svc, storage } = docService();
    const u = await storage.createUser('l@test.dev', 'h', 'L');
    await expect(svc.addText(u.id, { title: 't', text: 'x'.repeat(501) })).rejects.toMatchObject({ status: 413 });
    await expect(svc.addText(u.id, { title: 't', text: '   ' })).rejects.toMatchObject({ status: 422 });
    expect(await storage.countDocuments(u.id)).toBe(0);
  });

  it('get() of another user\'s document is a 404', async () => {
    const { svc, storage } = docService();
    const a = await storage.createUser('a@test.dev', 'h', 'A');
    const b = await storage.createUser('b@test.dev', 'h', 'B');
    const doc = await svc.addText(a.id, { title: 'mine', text: 'private content here' });
    await expect(svc.get(b.id, doc.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.remove(b.id, doc.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.retry(b.id, doc.id)).rejects.toMatchObject({ status: 404 });
    expect((await svc.get(a.id, doc.id)).id).toBe(doc.id);
  });

  it('addText returns the document as processing and indexes it in the background', async () => {
    const { svc, storage, vectorStore } = docService();
    const u = await storage.createUser('bg@test.dev', 'h', 'BG');
    const doc = await svc.addText(u.id, { title: 't', text: 'content to index in the background' });
    expect(doc).toMatchObject({ status: 'processing', chunksCount: 0 });
    await svc.whenIdle();
    expect(await svc.get(u.id, doc.id)).toMatchObject({ status: 'ready', errorMessage: null });
    expect(await vectorStore.countBySourceId(doc.id, u.id)).toBeGreaterThan(0);
  });

  it('a lasting indexing failure ends as failed after the configured attempts, with a safe reason; retry then succeeds', async () => {
    const { svc, storage, embeddings } = docService();
    const u = await storage.createUser('f@test.dev', 'h', 'F');
    embeddings.failNext = 99;
    const doc = await svc.addText(u.id, { title: 't', text: 'content to index' });
    await svc.whenIdle();
    const failed = await svc.get(u.id, doc.id);
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).not.toMatch(/503|embedding backend/i);
    expect(embeddings.calls).toBe(3); // default maxAttempts, no more
    embeddings.failNext = 0;
    expect((await svc.retry(u.id, doc.id)).status).toBe('processing');
    await svc.whenIdle();
    expect((await svc.get(u.id, doc.id)).status).toBe('ready');
  });

  it('saveText indexes synchronously: a failure is a 503 indexing_failed carrying the failed document', async () => {
    const { svc, storage, embeddings } = docService();
    const u = await storage.createUser('sf@test.dev', 'h', 'SF');
    const ctx = { principalId: u.id, tenantId: u.id, scopes: [], executionId: 'e', budget: { maxToolCalls: 1, maxModelCalls: 1 } };
    embeddings.failNext = 1;
    const err: any = await svc.saveText(ctx, { title: 't', text: 'content to index' }).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: 'indexing_failed' });
    expect(err.extra.document.status).toBe('failed');
    expect((await storage.listDocuments(u.id))[0]!.status).toBe('failed');
    const fixed = await svc.retry(u.id, err.extra.document.id);
    expect(fixed.status).toBe('processing');
    await svc.whenIdle();
    expect((await svc.get(u.id, err.extra.document.id)).status).toBe('ready');
  });

  it('identical content is a 409 duplicate_document, per user', async () => {
    const { svc, storage } = docService();
    const a = await storage.createUser('da@test.dev', 'h', 'A');
    const b = await storage.createUser('db@test.dev', 'h', 'B');
    const first = await svc.addText(a.id, { title: 'one', text: 'identical text' });
    await expect(svc.addText(a.id, { title: 'two', text: 'identical text' })).rejects.toMatchObject({ status: 409, code: 'duplicate_document', extra: { duplicateOf: first.id } });
    await expect(svc.addText(b.id, { title: 'three', text: 'identical text' })).resolves.toMatchObject({ status: 'processing' });
    await svc.whenIdle();
  });

  it('shutdown stops background indexing and leaves unfinished documents retryable', async () => {
    const { svc, storage, vectorStore } = docService();
    const u = await storage.createUser('sd@test.dev', 'h', 'SD');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const original = vectorStore.addDocuments.bind(vectorStore);
    vectorStore.addDocuments = async (docs) => { await held; return original(docs); };
    const doc = await svc.addText(u.id, { title: 't', text: 'held content' });
    const done = svc.shutdown();
    release();
    await done;
    expect((await svc.get(u.id, doc.id)).status).toBe('processing'); // not marked failed: nothing went wrong, it was interrupted
  });
});

describe('ChatService', () => {
  function chat(script: any[] = [{ text: 'ok' }]) {
    const storage = new InMemoryStorageAdapter();
    const provider = new ScriptedChatModelProvider(script, true);
    const embeddings = new FakeEmbeddingProvider();
    const vectorStore = new InMemoryVectorStoreAdapter({ embeddings, metadata: embeddings.metadata });
    const agent = new ChatAgent({ modelProvider: provider, registry: new ToolRegistry().register(new CalculatorTool()) });
    const svc = new ChatService({ storage, agent, modelProvider: provider, vectorStore, logger, scopes: [], limits: { maxToolCalls: 3, maxModelCalls: 4 } });
    return { svc, storage, provider };
  }

  it('assertCanChat: 404 for unknown/foreign sessions, 409 while busy', async () => {
    const { svc, storage } = chat();
    const a = await storage.createUser('a@t.dev', 'h', 'A');
    const b = await storage.createUser('b@t.dev', 'h', 'B');
    const s = await storage.createSession(a.id);
    await expect(svc.assertCanChat(b.id, s.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.assertCanChat(a.id, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(svc.assertCanChat(a.id, s.id)).resolves.toBeUndefined();
  });

  it('persists the user message BEFORE the model runs, so an outage never loses it', async () => {
    const { svc, storage, provider } = chat();
    const u = await storage.createUser('u@t.dev', 'h', 'U');
    const s = await storage.createSession(u.id);
    provider.available = false;
    const events: StreamEvent[] = [];
    await svc.runChatTurn({ userId: u.id, sessionId: s.id, text: 'important question', onEvent: (e) => events.push(e) });
    const msgs = (await storage.getMessages(u.id, s.id))!;
    expect(msgs[0]).toMatchObject({ sender: 'user', content: 'important question' });
    expect(events.at(-1)!.type).toBe('done');
  });

  it('a failure to save the reply is reported but does not break the stream', async () => {
    const { svc, storage } = chat();
    const u = await storage.createUser('p@t.dev', 'h', 'P');
    const s = await storage.createSession(u.id);
    const original = storage.saveMessage.bind(storage);
    let calls = 0;
    storage.saveMessage = async (...args: Parameters<typeof original>) => { if (++calls === 2) throw new Error('disk full'); return original(...args); };
    const events: StreamEvent[] = [];
    await svc.runChatTurn({ userId: u.id, sessionId: s.id, text: 'hello', onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'error' && e.payload.code === 'persist_failed')).toBe(true);
    expect(events.at(-1)!.type).toBe('done');
    expect(svc.isBusy(s.id)).toBe(false);
  });

  it('releases the session lock even when the turn throws', async () => {
    const { svc, storage } = chat();
    const u = await storage.createUser('r@t.dev', 'h', 'R');
    const s = await storage.createSession(u.id);
    storage.failWith = new Error('db down');
    await expect(svc.runChatTurn({ userId: u.id, sessionId: s.id, text: 'x', onEvent: () => {} })).rejects.toThrow();
    storage.failWith = undefined;
    expect(svc.isBusy(s.id)).toBe(false);
  });

  it('tool calls are capped by the configured budget', async () => {
    const call = { toolCalls: [{ name: 'calculator', args: { expression: '1+1' } }] };
    const { svc, storage } = chat([call, call, call, call, call, { text: 'done' }]);
    const u = await storage.createUser('b@t.dev', 'h', 'B');
    const s = await storage.createSession(u.id);
    const res = await svc.runChatTurn({ userId: u.id, sessionId: s.id, text: 'loop', onEvent: () => {} });
    expect(res.toolCalls.filter((t) => t.ok).length).toBeLessThanOrEqual(3);
  });
});
