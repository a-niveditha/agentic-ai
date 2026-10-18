import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ApiClient, ofType, readSse, tokensOf } from '../../../../tests/helpers/http.js';
import { startTestApp, type TestHarness } from '../../../../tests/helpers/testApp.js';

let h: TestHarness;
let alice: ApiClient;
let n = 0;
beforeAll(async () => { h = await startTestApp({ script: [{ text: 'Scripted reply.' }], repeatLast: true }); });
afterAll(() => h.close());
beforeEach(async () => { alice = new ApiClient(h.server.url); await alice.signup(`chat${++n}@test.dev`); h.model.available = true; });

const newSession = async (c = alice, title?: string) => (await c.json('POST', '/api/v1/chat/sessions', { json: title ? { title } : {} })).body.session as { id: string; title: string };
const send = (id: string, text: string, c = alice) => c.request('POST', `/api/v1/chat/sessions/${id}/messages`, { json: { text } });

describe('sessions CRUD', () => {
  it('creates, lists, renames and deletes', async () => {
    const s = await newSession(alice, 'Planning');
    expect(s.title).toBe('Planning');
    expect((await alice.json('GET', '/api/v1/chat/sessions')).body.sessions.map((x: any) => x.id)).toContain(s.id);
    expect((await alice.json('PATCH', `/api/v1/chat/sessions/${s.id}`, { json: { title: 'Renamed' } })).status).toBe(200);
    expect((await alice.json('GET', '/api/v1/chat/sessions')).body.sessions.find((x: any) => x.id === s.id).title).toBe('Renamed');
    expect((await alice.json('DELETE', `/api/v1/chat/sessions/${s.id}`)).status).toBe(200);
    expect((await alice.json('DELETE', `/api/v1/chat/sessions/${s.id}`)).status).toBe(404);
  });

  it('requires auth and valid ids/titles', async () => {
    expect((await alice.json('GET', '/api/v1/chat/sessions', { auth: false })).status).toBe(401);
    expect((await alice.json('GET', '/api/v1/chat/sessions/not-a-uuid/messages')).status).toBe(400);
    expect((await alice.json('POST', '/api/v1/chat/sessions', { json: { title: 'x'.repeat(101) } })).status).toBe(400);
    expect((await alice.json('GET', '/api/v1/chat/sessions/3f2b8c1e-0000-4000-8000-000000000099/messages')).status).toBe(404);
  });
});

describe('POST /sessions/:id/messages (SSE)', () => {
  it('streams start -> tokens -> done, and persists both messages', async () => {
    const s = await newSession();
    const res = await send(s.id, 'Hello agent');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(res);
    expect(events[0]!.type).toBe('start');
    expect(tokensOf(events)).toBe('Scripted reply.');
    const done = events.at(-1)!;
    expect(done.type).toBe('done');
    expect(done.payload).toMatchObject({ sessionId: s.id, status: 'completed', fullResponse: 'Scripted reply.' });
    expect(done.payload.messageId).toBeTruthy();

    const msgs = (await alice.json('GET', `/api/v1/chat/sessions/${s.id}/messages`)).body.messages;
    expect(msgs.map((m: any) => [m.sender, m.content])).toEqual([['user', 'Hello agent'], ['agent', 'Scripted reply.']]);
    expect(msgs[1].metadata).toMatchObject({ status: 'completed' });
  });

  it('retrieves the signed-in user\'s indexed passages before generation and saves citations', async () => {
    const added = await alice.json('POST', '/api/v1/documents', {
      json: { title: 'Release Handbook', text: 'The support team reviews deployments every Friday morning.' },
    });
    expect(added.status).toBe(202);
    const doc = await alice.waitForDocument(added.body.document.id);
    expect(doc.status).toBe('ready');

    const s = await newSession();
    const events = await readSse(await send(s.id, 'When does the support team review deployments?'));
    expect(ofType(events, 'tool_start').some((e) => e.payload.tool === 'knowledge_base_search')).toBe(true);
    expect(ofType(events, 'tool_end').some((e) => e.payload.tool === 'knowledge_base_search' && e.payload.success)).toBe(true);
    expect(ofType(events, 'citation').flatMap((e) => e.payload.citations)).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Release Handbook', sourceId: doc.id, content: expect.stringContaining('Friday morning') }),
    ]));

    const modelPrompt = JSON.stringify(h.model.lastModel!.received[0]);
    expect(modelPrompt).toContain('The support team reviews deployments every Friday morning.');
    expect(modelPrompt).toContain('Do not call knowledge_base_search again.');

    const messages = (await alice.json('GET', `/api/v1/chat/sessions/${s.id}/messages`)).body.messages;
    expect(messages[1].metadata.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Release Handbook', sourceId: doc.id }),
    ]));
    expect(messages[1].metadata.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'knowledge_base_search', ok: true }),
    ]));
  });

  it('auto-titles a new conversation from the first message (but keeps custom titles)', async () => {
    const s = await newSession();
    await readSse(await send(s.id, '  What is the   capital of France?  '));
    expect((await alice.json('GET', '/api/v1/chat/sessions')).body.sessions.find((x: any) => x.id === s.id).title).toBe('What is the capital of France?');
    const custom = await newSession(alice, 'My title');
    await readSse(await send(custom.id, 'hello'));
    expect((await alice.json('GET', '/api/v1/chat/sessions')).body.sessions.find((x: any) => x.id === custom.id).title).toBe('My title');
  });

  it('remembers earlier turns: the model receives the prior conversation (memory)', async () => {
    const s = await newSession();
    await readSse(await send(s.id, 'My name is Priya.'));
    await readSse(await send(s.id, 'What is my name?'));
    const prompt = JSON.stringify(h.model.lastModel!.received[0]!.map((m) => m.content));
    expect(prompt).toContain('My name is Priya.');
    expect(prompt).toContain('Scripted reply.');
    expect(prompt).toContain('What is my name?');
  });

  it('validates the message', async () => {
    const s = await newSession();
    for (const text of ['', '   ', 'x'.repeat(4001)]) expect((await send(s.id, text)).status).toBe(400);
    expect((await alice.request('POST', `/api/v1/chat/sessions/${s.id}/messages`, { json: {} })).status).toBe(400);
  });

  it('404 for missing sessions before any stream starts', async () => {
    const res = await send('3f2b8c1e-0000-4000-8000-000000000099', 'hi');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('DEGRADES when the model is down: user message is saved, a friendly error event is sent, history shows the failure', async () => {
    const s = await newSession();
    h.model.available = false;
    const events = await readSse(await send(s.id, 'Are you there?'));
    const err = ofType(events, 'error')[0]!;
    expect(err.payload.code).toBe('model_unavailable');
    expect(err.payload.message).not.toMatch(/scripted|503/i);
    expect(events.at(-1)!.payload.status).toBe('error');

    const msgs = (await alice.json('GET', `/api/v1/chat/sessions/${s.id}/messages`)).body.messages;
    expect(msgs[0]).toMatchObject({ sender: 'user', content: 'Are you there?' });
    expect(msgs[1].sender).toBe('agent');
    expect(msgs[1].content).toContain("couldn't complete");
    expect(msgs[1].metadata.status).toBe('error');

    // Recovery: the failed turn is not replayed to the model as if it said it.
    h.model.available = true;
    await readSse(await send(s.id, 'Try again'));
    const prompt = JSON.stringify(h.model.lastModel!.received[0]!.map((m) => m.content));
    expect(prompt).toContain('Are you there?');
    expect(prompt).not.toContain("couldn't complete");
  });

  it('refuses a second concurrent message in the same session (409) and releases the lock afterwards', async () => {
    const slow = await startTestApp({ script: [() => { return { text: 'slow reply' }; }], repeatLast: true });
    try {
      const c = new ApiClient(slow.server.url); await c.signup('busy@test.dev');
      const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session;
      // Hold the lock by marking busy through an in-flight first request.
      const first = c.request('POST', `/api/v1/chat/sessions/${s.id}/messages`, { json: { text: 'one' } });
      let second = 0;
      for (let i = 0; i < 30 && second !== 409; i++) {
        if (slow.deps.chat.isBusy(s.id)) second = (await c.request('POST', `/api/v1/chat/sessions/${s.id}/messages`, { json: { text: 'two' } })).status;
        else await new Promise((r) => setTimeout(r, 2));
      }
      await readSse(await first);
      expect(slow.deps.chat.isBusy(s.id)).toBe(false);
      expect((await c.request('POST', `/api/v1/chat/sessions/${s.id}/messages`, { json: { text: 'three' } })).status).toBe(200);
      if (second) expect(second).toBe(409);
    } finally { await slow.close(); }
  });

  it('runs tools end to end: tool_start/tool_end events, metadata with tool calls', async () => {
    const tools = await startTestApp({ script: [{ toolCalls: [{ name: 'calculator', args: { expression: '6*7' } }] }, { text: 'It is 42.' }] });
    try {
      const c = new ApiClient(tools.server.url); await c.signup('tools@test.dev');
      const s = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session;
      const events = await readSse(await c.request('POST', `/api/v1/chat/sessions/${s.id}/messages`, { json: { text: 'what is 6*7' } }));
      expect(ofType(events, 'tool_start').find((e) => e.payload.tool === 'calculator')!.payload).toMatchObject({ input: { expression: '6*7' } });
      expect(ofType(events, 'tool_end').find((e) => e.payload.tool === 'calculator')!.payload).toMatchObject({ success: true, output: '6*7 = 42' });
      expect(tokensOf(events)).toBe('It is 42.');
      const msgs = (await c.json('GET', `/api/v1/chat/sessions/${s.id}/messages`)).body.messages;
      expect(msgs[1].metadata.toolCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'knowledge_base_search', ok: true }),
        { name: 'calculator', input: { expression: '6*7' }, ok: true },
      ]));
    } finally { await tools.close(); }
  });
});

describe('GET /sessions/:id/stream?ticket= (EventSource)', () => {
  const ticketFor = async (c: ApiClient, sessionId?: string) => (await c.json('POST', '/api/v1/auth/stream-ticket', { json: sessionId ? { sessionId } : {} })).body.ticket as string;
  const stream = (id: string, ticket: string, text = 'hello') => fetch(`${h.server.url}/api/v1/chat/sessions/${id}/stream?ticket=${encodeURIComponent(ticket)}&text=${encodeURIComponent(text)}`);

  it('streams a reply when given a valid ticket', async () => {
    const s = await newSession();
    const events = await readSse(await stream(s.id, await ticketFor(alice, s.id), 'via ticket'));
    expect(tokensOf(events)).toBe('Scripted reply.');
    expect((await alice.json('GET', `/api/v1/chat/sessions/${s.id}/messages`)).body.messages[0].content).toBe('via ticket');
  });

  it('a ticket is single-use', async () => {
    const s = await newSession();
    const t = await ticketFor(alice);
    expect((await stream(s.id, t)).status).toBe(200);
    expect((await stream(s.id, t)).status).toBe(401);
  });

  it('rejects missing/garbage tickets and a bearer access token in the ticket slot', async () => {
    const s = await newSession();
    expect((await fetch(`${h.server.url}/api/v1/chat/sessions/${s.id}/stream?text=hi`)).status).toBe(400);
    expect((await stream(s.id, 'garbage')).status).toBe(401);
    expect((await stream(s.id, alice.token!)).status).toBe(401);
  });

  it('a ticket bound to one session cannot stream another', async () => {
    const s1 = await newSession(); const s2 = await newSession();
    expect((await stream(s2.id, await ticketFor(alice, s1.id))).status).toBe(401);
  });

  it('a ticket cannot be used as a normal API credential', async () => {
    const t = await ticketFor(alice);
    expect((await alice.json('GET', '/api/v1/chat/sessions', { auth: t })).status).toBe(401);
  });

  it('another user\'s ticket cannot stream into my session (404, nothing written)', async () => {
    const s = await newSession();
    const mallory = new ApiClient(h.server.url); await mallory.signup(`mallory${++n}@test.dev`);
    expect((await stream(s.id, await ticketFor(mallory))).status).toBe(404);
    expect((await alice.json('GET', `/api/v1/chat/sessions/${s.id}/messages`)).body.messages).toEqual([]);
  });

  it('limits the text length in the URL', async () => {
    const s = await newSession();
    expect((await stream(s.id, await ticketFor(alice), 'x'.repeat(2001))).status).toBe(400);
  });
});
