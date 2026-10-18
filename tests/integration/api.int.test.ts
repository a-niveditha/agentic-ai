import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FACTS, buildFixtureFiles, type FixtureFile } from '../helpers/fixtures.js';
import { geminiApiKey } from '../helpers/gemini.js';
import { ApiClient, ofType, readSse, tokensOf } from '../helpers/http.js';
import { startLiveApp, type LiveHarness } from '../helpers/liveApp.js';
import { GeminiChatModelProvider } from '../../agent/src/index.js';

const live = geminiApiKey ? describe : describe.skip;

live('API on real infrastructure (Gemini + disk Chroma + SQLite)', () => {
  let h: LiveHarness;
  let c: ApiClient;
  let fixtures: FixtureFile[];
  let userId: string;
  const docIds: Record<string, string> = {};

  beforeAll(async () => {
    fixtures = await buildFixtureFiles();
    h = await startLiveApp({ name: 'api' });
    c = new ApiClient(h.server.url);
    expect((await c.signup('live-user@test.dev')).status).toBe(201);
    userId = (await c.json('GET', '/api/v1/auth/me')).body.user.id;
  }, 120_000);
  afterAll(async () => { await h?.close(); });

  it('readiness reports every real component as up', async () => {
    const r = await (await fetch(h.server.url + '/api/v1/ready')).json();
    expect(r.status === 'up' || r.status === 'degraded').toBe(true);
    expect(r.components.database).toBe('up');
    expect(r.components['vectorstore:chroma']).toBe('up');
    expect(r.components['llm:gemini']).toBe('up');
    expect(r.components['embeddings:gemini']).toBe('up');
  }, 60_000);

  it('uploads every file type; each becomes ready and is persisted in SQLite and Chroma', async () => {
    for (const f of fixtures) {
      const r = await c.upload(f.filename, f.buffer, f.mimeType);
      expect({ kind: f.kind, status: r.status }).toEqual({ kind: f.kind, status: 202 });
      expect(r.body.document.status).toBe('processing');
      docIds[f.kind] = r.body.document.id;
      const done = await c.waitForDocument(r.body.document.id);
      expect(done.status).toBe('ready');
      expect(await h.vectorStore.countBySourceId(r.body.document.id, userId)).toBe(done.chunksCount);
    }
    const listed = (await c.json('GET', '/api/v1/documents')).body.documents;
    expect(listed).toHaveLength(fixtures.length);
    expect(await h.prisma.document.count({ where: { userId } })).toBe(fixtures.length);
  }, 300_000);

  it('standalone RAG answers each document\'s question with the right citation', async () => {
    for (const f of fixtures) {
      const r = await c.json('POST', '/api/v1/rag/query', { json: { question: FACTS[f.kind].question } });
      expect({ kind: f.kind, status: r.status, s: r.body.status }).toEqual({ kind: f.kind, status: 200, s: 'completed' });
      expect(r.body.answer.toLowerCase()).toContain(FACTS[f.kind].answer.toLowerCase().split(' ')[0]!);
      expect(r.body.citations.map((x: any) => x.sourceId)).toContain(docIds[f.kind]);
    }
  }, 600_000);

  it('another user gets nothing from these documents (RAG + document list)', async () => {
    const other = new ApiClient(h.server.url); await other.signup('other-live@test.dev');
    expect((await other.json('GET', '/api/v1/documents')).body.documents).toEqual([]);
    const r = await other.json('POST', '/api/v1/rag/query', { json: { question: FACTS.txt.question } });
    expect(r.body.status).toBe('no_context');
    expect((await other.json('GET', `/api/v1/documents/${docIds.txt}`)).status).toBe(404);
    expect((await other.json('DELETE', `/api/v1/documents/${docIds.txt}`)).status).toBe(404);
    expect(await h.vectorStore.countBySourceId(docIds.txt!, userId)).toBeGreaterThan(0); // still intact
  }, 120_000);

  it('deleting a document removes it from SQLite AND Chroma, and it stops being retrievable', async () => {
    expect((await c.json('DELETE', `/api/v1/documents/${docIds.csv}`)).status).toBe(200);
    expect(await h.vectorStore.countBySourceId(docIds.csv!, userId)).toBe(0);
    expect(await h.prisma.document.count({ where: { id: docIds.csv } })).toBe(0);
    const hits = await h.vectorStore.similaritySearch(FACTS.csv.question, 5, { userId });
    expect(hits.some((x) => x.document.metadata.sourceId === docIds.csv)).toBe(false);
  }, 120_000);

  it('CHROMA OUTAGE: server stays up and reports degradation; uploads fail safely; recovery restores everything', async () => {
    await h.chroma.kill();

    // liveness untouched, readiness shows the failing component, server keeps serving
    expect((await fetch(h.server.url + '/api/v1/health')).status).toBe(200);
    const ready = await fetch(h.server.url + '/api/v1/ready');
    expect(ready.status).toBe(200);
    expect((await ready.json()).components['vectorstore:chroma']).toBe('down');
    expect((await c.json('GET', '/api/v1/auth/me')).status).toBe(200);
    expect((await c.json('GET', '/api/v1/documents')).status).toBe(200);

    // an upload during the outage is accepted, then ends as a failed doc (after automatic retries), not lost
    const accepted = await c.upload('during-outage.md', Buffer.from(`# Outage notes\n\nThe Tessellate Protocol was drafted during the outage (${Date.now()}).`), 'text/markdown');
    expect(accepted.status).toBe(202);
    const failedDoc = await c.waitForDocument(accepted.body.document.id);
    expect(failedDoc.status).toBe('failed');
    expect(failedDoc.errorMessage).toBeTruthy();
    const failed = { body: { document: failedDoc } };

    // RAG says unavailable; deleting is refused without deleting
    expect((await c.json('POST', '/api/v1/rag/query', { json: { question: 'anything' } })).status).toBe(503);
    expect((await c.json('DELETE', `/api/v1/documents/${docIds.txt}`)).status).toBe(503);
    expect((await c.json('GET', `/api/v1/documents/${docIds.txt}`)).status).toBe(200);

    // chat keeps working without the knowledge base; the model is told the tool failed
    const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session;
    const events = await readSse(await c.request('POST', `/api/v1/chat/sessions/${s.id}/messages`, { json: { text: 'Say hello in exactly three words. Do not use any tools.' } }));
    expect(events.at(-1)!.payload.status).toBe('completed');
    expect(tokensOf(events).length).toBeGreaterThan(0);

    // recovery
    await h.chroma.restart();
    await new Promise((r) => setTimeout(r, 800)); // breaker cooldown
    let ok = false;
    for (let i = 0; i < 15 && !ok; i++) {
      const r = await c.json('POST', `/api/v1/documents/${failed.body.document.id}/retry`);
      ok = r.status === 202;
      if (!ok) await new Promise((res) => setTimeout(res, 700));
    }
    expect(ok).toBe(true);
    expect((await c.waitForDocument(failed.body.document.id)).status).toBe('ready');
    expect((await (await fetch(h.server.url + '/api/v1/ready')).json()).components['vectorstore:chroma']).toBe('up');
    // pre-outage data survived on disk
    const hit = await h.vectorStore.similaritySearch(FACTS.txt.question, 1, { userId });
    expect(hit[0]!.document.pageContent).toContain('Zorblax');
  }, 300_000);
});

live('API with a rejected Gemini key (graceful degradation)', () => {
  let h: LiveHarness;
  let c: ApiClient;
  beforeAll(async () => {
    h = await startLiveApp({ name: 'badkey', modelProvider: new GeminiChatModelProvider({ apiKey: 'AIzaSyINVALID-KEY-FOR-TESTING-0000000000000', maxRetries: 0 }) });
    c = new ApiClient(h.server.url);
    await c.signup('badkey@test.dev');
  }, 120_000);
  afterAll(async () => { await h?.close(); });

  it('chat returns a friendly error, never the key or provider text, and keeps the conversation', async () => {
    const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session;
    const res = await c.request('POST', `/api/v1/chat/sessions/${s.id}/messages`, { json: { text: 'hello?' } });
    const events = await readSse(res);
    const err = ofType(events, 'error')[0]!;
    expect(err.payload.message).toMatch(/credentials|unavailable/i);
    expect(JSON.stringify(events)).not.toMatch(/AIzaSy|INVALID-KEY|generativelanguage/);
    const msgs = (await c.json('GET', `/api/v1/chat/sessions/${s.id}/messages`)).body.messages;
    expect(msgs[0]).toMatchObject({ sender: 'user', content: 'hello?' });
    expect(msgs[1].metadata.status).toBe('error');
  }, 120_000);

  it('documents still upload and index (embeddings use a different, valid path), and RAG degrades to passages', async () => {
    const up = await c.json('POST', '/api/v1/documents', { json: { title: 'Facts', text: FACTS.txt.text } });
    expect(up.status).toBe(202);
    expect((await c.waitForDocument(up.body.document.id)).status).toBe('ready');
    const r = await c.json('POST', '/api/v1/rag/query', { json: { question: FACTS.txt.question } });
    expect(r.body.status).toBe('degraded');
    expect(r.body.answer).toContain('4242');
    expect(r.body.citations).toHaveLength(1);
  }, 180_000);

  it('readiness shows the LLM down while the server stays up', async () => {
    const r = await fetch(h.server.url + '/api/v1/ready');
    expect(r.status).toBe(200);
    expect((await r.json()).components['llm:gemini']).toBe('down');
  });
});
