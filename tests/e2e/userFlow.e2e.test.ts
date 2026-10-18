/**
 * End-to-end journey of one dummy user on REAL infrastructure:
 * real Gemini (paced), real disk-backed Chroma, real SQLite via Prisma, real HTTP scraping.
 *
 * Web *search* uses a fixed provider that points at a real public page, because DuckDuckGo throttles anonymous
 * scrapers (its own behavior is covered in agent/src/web). Everything after the search is live: the page is scraped
 * over the internet, indexed, retrieved and cited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { WebSocket } from 'ws';
import type { SearchProvider } from '../../agent/src/index.js';
import { FACTS, buildFixtureFiles, type FixtureFile } from '../helpers/fixtures.js';
import { geminiApiKey } from '../helpers/gemini.js';
import { ApiClient, ofType, readSse, tokensOf, type SseEvent } from '../helpers/http.js';
import { startLiveApp, type LiveHarness } from '../helpers/liveApp.js';

const live = geminiApiKey ? describe : describe.skip;

const fixedSearch: SearchProvider = {
  name: 'fixed',
  componentName: 'search:fixed',
  async search() {
    return [{ title: 'Example Domain', url: 'https://example.com/', snippet: 'Example Domain. This domain is for use in documentation examples.' }];
  },
  async checkHealth() { return { status: 'up', checkedAt: Date.now() }; },
};

const EMAIL = 'dummy.user@example.test';
const PASSWORD = 'correct-horse-battery-staple';

live('E2E: one user, start to finish', () => {
  let h: LiveHarness;
  let c: ApiClient;
  let fixtures: FixtureFile[];
  let userId = '';
  let sessionId = '';
  const docIds: Record<string, string> = {};
  const report: string[] = [];
  const log = (step: string, detail: string) => { report.push(`${step.padEnd(34)} ${detail}`); };

  const chat = async (text: string, session = sessionId): Promise<{ events: SseEvent[]; answer: string; done: any }> => {
    const res = await c.request('POST', `/api/v1/chat/sessions/${session}/messages`, { json: { text } });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    const done = events.at(-1)!;
    expect(done.type).toBe('done');
    return { events, answer: tokensOf(events), done: done.payload };
  };

  beforeAll(async () => {
    fixtures = await buildFixtureFiles();
    h = await startLiveApp({ name: 'e2e', searchProvider: fixedSearch });
    c = new ApiClient(h.server.url);
  }, 180_000);

  afterAll(async () => {
    console.log('\n──────── E2E REPORT ────────\n' + report.join('\n') + '\n────────────────────────────');
    await h?.close();
  });

  it('1. signs up, logs in and fetches the profile', async () => {
    const signup = await c.signup(EMAIL, PASSWORD, 'Dummy User');
    expect(signup.status).toBe(201);
    const login = await c.json('POST', '/api/v1/auth/login', { json: { email: EMAIL, password: PASSWORD }, auth: false });
    expect(login.status).toBe(200);
    c.token = login.body.token;
    const me = await c.json('GET', '/api/v1/auth/me');
    expect(me.body.user).toMatchObject({ email: EMAIL, name: 'Dummy User' });
    userId = me.body.user.id;
    log('signup → login → me', `user ${userId.slice(0, 8)}… authenticated`);
  }, 60_000);

  it('2. starts a conversation and gets a streamed reply', async () => {
    sessionId = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id;
    const { events, answer, done } = await chat('Hello! Reply with a short greeting and do not use any tools.');
    expect(done.status).toBe('completed');
    expect(answer.length).toBeGreaterThan(2);
    expect(ofType(events, 'tool_start')).toHaveLength(0);
    const title = (await c.json('GET', '/api/v1/chat/sessions')).body.sessions[0].title;
    expect(title).toContain('Hello');
    log('plain chat (streamed)', `${ofType(events, 'token').length} token events, auto-title "${title.slice(0, 30)}"`);
  }, 180_000);

  it('3. uploads every supported file type and a web page into the knowledge base', async () => {
    for (const f of fixtures) {
      const r = await c.upload(f.filename, f.buffer, f.mimeType);
      expect({ kind: f.kind, status: r.status, doc: r.body.document?.status }).toEqual({ kind: f.kind, status: 202, doc: 'processing' });
      docIds[f.kind] = r.body.document.id;
      const done = await c.waitForDocument(r.body.document.id);
      expect({ kind: f.kind, status: done.status }).toEqual({ kind: f.kind, status: 'ready' });
      log(`upload .${f.kind}`, `accepted (202) → ready, ${done.chunksCount} chunk(s) indexed`);
    }
    const url = await c.json('POST', '/api/v1/documents', { json: { url: 'https://example.com/' } });
    expect(url.status).toBe(202);
    expect(url.body.document).toMatchObject({ status: 'processing', sourceUrl: 'https://example.com/' });
    docIds.url = url.body.document.id;
    const urlDone = await c.waitForDocument(url.body.document.id);
    expect(urlDone.status).toBe('ready');
    log('add by URL', `example.com → ${urlDone.chunksCount} chunk(s)`);
    const list = await c.waitForIndexing();
    expect(list).toHaveLength(fixtures.length + 1);
    expect(list.every((d: any) => d.status === 'ready')).toBe(true);
  }, 400_000);

  it('3b. re-uploading identical content is refused as a duplicate and names the original', async () => {
    const f = fixtures.find((x) => x.kind === 'txt')!;
    const dup = await c.upload(f.filename, f.buffer, f.mimeType);
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'duplicate_document', duplicateOf: docIds.txt });
    log('duplicate upload', '409 duplicate_document → original named ✓');
  }, 60_000);

  for (const kind of ['txt', 'md', 'pdf', 'docx', 'html', 'csv', 'json'] as const) {
    it(`4. chat answers from the .${kind} document and cites it`, async () => {
      const { events, answer, done } = await chat(`${FACTS[kind].question} Search my knowledge base.`);
      expect(done.status).toBe('completed');
      const searched = ofType(events, 'tool_start').some((e) => e.payload.tool === 'knowledge_base_search');
      expect(searched).toBe(true);
      const cited = ofType(events, 'citation').flatMap((e) => e.payload.citations.map((x: any) => x.sourceId));
      expect(cited).toContain(docIds[kind]);
      expect(answer.toLowerCase().replace(/[,\s]/g, '')).toContain(FACTS[kind].answer.toLowerCase().replace(/[,\s]/g, '').slice(0, 8));
      log(`chat → .${kind} citation`, `cited ✓  "${answer.replace(/\s+/g, ' ').slice(0, 60)}…"`);
    }, 240_000);
  }

  it('5. uses the calculator tool', async () => {
    const { events, answer, done } = await chat('What is 4821 * 317? Use the calculator tool and give me the exact number.');
    expect(done.status).toBe('completed');
    expect(ofType(events, 'tool_start').some((e) => e.payload.tool === 'calculator')).toBe(true);
    expect(ofType(events, 'tool_end').some((e) => e.payload.tool === 'calculator' && e.payload.success)).toBe(true);
    expect(answer.replace(/[,\s]/g, '')).toContain('1528257');
    log('tool call: calculator', '4821 × 317 = 1528257 ✓');
  }, 240_000);

  it('6. searches the web, reads a page, saves it to the knowledge base, then reuses it with a citation', async () => {
    const s = (await c.json('POST', '/api/v1/chat/sessions', { json: { title: 'Web research' } })).body.session.id as string;
    const before = (await c.json('GET', '/api/v1/documents')).body.documents.length;
    // Remove the URL doc added in step 3 so we can prove the *agent* creates it.
    await c.json('DELETE', `/api/v1/documents/${docIds.url}`);

    const first = await chat('Use web_search to look up "example domain", then use save_to_knowledge_base to save the first result URL, and tell me when it is saved.', s);
    expect(first.done.status).toBe('completed');
    const tools = ofType(first.events, 'tool_start').map((e) => e.payload.tool);
    expect(tools).toContain('web_search');
    expect(tools).toContain('save_to_knowledge_base');
    expect(ofType(first.events, 'tool_end').some((e) => e.payload.tool === 'save_to_knowledge_base' && e.payload.success)).toBe(true);

    const docs = (await c.json('GET', '/api/v1/documents')).body.documents;
    const saved = docs.find((d: any) => d.sourceUrl === 'https://example.com/');
    expect(saved).toBeTruthy();
    expect(saved.status).toBe('ready');
    expect(docs.length).toBe(before); // deleted one + the agent re-created one
    log('web_search → save_to_kb', `agent saved example.com as doc ${saved.id.slice(0, 8)}…`);

    const second = await chat('What does my saved Example Domain page say it is for? Search my knowledge base.', s);
    const cited = ofType(second.events, 'citation').flatMap((e) => e.payload.citations);
    expect(cited.some((x: any) => x.sourceId === saved.id)).toBe(true);
    expect(second.answer.toLowerCase()).toMatch(/documentation|example/);
    log('reuse saved page', 'follow-up answered from the saved page, cited ✓');
    docIds.url = saved.id;
  }, 600_000);

  it('7. scrapes a page on request (web_scrape) and cites the URL', async () => {
    const { events, done } = await chat('Use web_scrape to read https://example.com/ and tell me its title in a few words.');
    expect(done.status).toBe('completed');
    expect(ofType(events, 'tool_start').some((e) => e.payload.tool === 'web_scrape')).toBe(true);
    const cited = ofType(events, 'citation').flatMap((e) => e.payload.citations);
    expect(cited.some((x: any) => x.url === 'https://example.com/')).toBe(true);
    log('tool call: web_scrape', 'page read live + cited ✓');
  }, 240_000);

  it('8. remembers the conversation (memory across turns)', async () => {
    const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id as string;
    await chat('Please remember: my cat is named Biscuit and she is orange. Do not use tools.', s);
    const { answer } = await chat('What is my cat called, and what colour is she? Do not use tools.', s);
    expect(answer.toLowerCase()).toContain('biscuit');
    expect(answer.toLowerCase()).toContain('orange');
    const stored = (await c.json('GET', `/api/v1/chat/sessions/${s}/messages`)).body.messages;
    expect(stored).toHaveLength(4);
    log('memory', 'recalled name + colour from earlier turn ✓');
  }, 360_000);

  it('9. chats over a WebSocket using a single-use ticket', async () => {
    const ticket = (await c.json('POST', '/api/v1/auth/stream-ticket', { json: {} })).body.ticket as string;
    const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/api/v1/ws?ticket=${ticket}`);
    const events: any[] = [];
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
    ws.on('message', (d) => events.push(JSON.parse(d.toString())));
    const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id as string;
    ws.send(JSON.stringify({ type: 'chat', sessionId: s, text: 'Say the word "pineapple" and nothing else. Do not use tools.' }));
    for (let i = 0; i < 600 && !events.some((e) => e.type === 'done'); i++) await new Promise((r) => setTimeout(r, 100));
    ws.close();
    const done = events.find((e) => e.type === 'done');
    expect(done.payload.status).toBe('completed');
    expect(events.filter((e) => e.type === 'token').map((e) => e.payload.token).join('').toLowerCase()).toContain('pineapple');
    log('WebSocket chat', 'ticket accepted, reply streamed ✓');
  }, 240_000);

  it('10. answers a stand-alone RAG query with citations', async () => {
    const r = await c.json('POST', '/api/v1/rag/query', { json: { question: FACTS.pdf.question } });
    expect(r.body.status).toBe('completed');
    expect(r.body.answer).toContain('Vantaroon');
    expect(r.body.citations.map((x: any) => x.sourceId)).toContain(docIds.pdf);
    log('standalone /api/v1/rag/query', 'grounded answer + citation ✓');
  }, 240_000);

  it('11. a deleted document is no longer cited or retrievable', async () => {
    expect((await c.json('DELETE', `/api/v1/documents/${docIds.txt}`)).status).toBe(200);
    expect(await h.vectorStore.countBySourceId(docIds.txt!, userId)).toBe(0);
    const { events } = await chat(`${FACTS.txt.question} Search my knowledge base.`);
    const cited = ofType(events, 'citation').flatMap((e) => e.payload.citations.map((x: any) => x.sourceId));
    expect(cited).not.toContain(docIds.txt);
    log('delete document', 'vectors removed; no longer cited ✓');
  }, 240_000);

  it('12. deletes a session and its messages', async () => {
    expect((await c.json('DELETE', `/api/v1/chat/sessions/${sessionId}`)).status).toBe(200);
    expect((await c.json('GET', `/api/v1/chat/sessions/${sessionId}/messages`)).status).toBe(404);
    expect(await h.prisma.chatMessage.count({ where: { sessionId } })).toBe(0);
    log('delete session', 'session + messages gone ✓');
  }, 60_000);

  it('13. leaves the system healthy', async () => {
    const ready = await (await fetch(h.server.url + '/api/v1/ready')).json();
    expect(ready.components.database).toBe('up');
    expect(ready.components['vectorstore:chroma']).toBe('up');
    log('final readiness', JSON.stringify(ready.components));
  });
});
