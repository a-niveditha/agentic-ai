import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { WebSocket } from 'ws';
import { ApiClient } from '../../../../tests/helpers/http.js';
import { spawnStreamingClient } from '../../../../tests/helpers/clientProcess.js';
import { SlowTool } from '../../../../tests/helpers/slowTool.js';
import { startTestApp, type TestHarness } from '../../../../tests/helpers/testApp.js';

let h: TestHarness;
let alice: ApiClient;
let n = 0;
const slow = new SlowTool();

beforeAll(async () => {
  h = await startTestApp({ script: [{ text: 'WS reply.' }], repeatLast: true });
  h.deps.registry.register(slow);
});
afterAll(() => h.close());
beforeEach(async () => { alice = new ApiClient(h.server.url); await alice.signup(`ws${++n}@test.dev`); h.model.available = true; slow.reset(); });

const wsUrl = (path = '/api/v1/ws', ticket?: string) => `ws://127.0.0.1:${h.server.port}${path}${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`;
const ticket = async (c = alice) => (await c.json('POST', '/api/v1/auth/stream-ticket', { json: {} })).body.ticket as string;
const session = async (c = alice) => (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id as string;

class Client {
  events: any[] = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (d) => this.events.push(JSON.parse(d.toString())));
  }
  send(o: unknown) { this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  async until(pred: (e: any) => boolean, ms = 5000) {
    const t = Date.now();
    while (Date.now() - t < ms) { const f = this.events.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('timeout waiting for event; got ' + JSON.stringify(this.events.map((e) => e.type)));
  }
  close() { this.ws.close(); }
}

async function connect(url: string, opts: { origin?: string } = {}): Promise<Client> {
  const ws = new WebSocket(url, { headers: opts.origin ? { Origin: opts.origin } : {} });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(Object.assign(new Error('handshake rejected'), { status: r.statusCode }))); });
  return new Client(ws);
}
/**
 * Performs a raw WebSocket upgrade from a separate Node process and reports the HTTP status the server answered
 * with (101 = accepted). A separate real client is used because in-process clients under Bun cannot observe
 * rejected handshakes' status codes.
 */
function handshakeStatus(url: string, opts: { origin?: string } = {}): Promise<number> {
  const script = `
    const http = require('http');
    const u = new URL(process.argv[1].replace('ws://', 'http://'));
    const headers = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64') };
    if (process.argv[2]) headers.Origin = process.argv[2];
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers });
    req.on('upgrade', (res, socket) => { console.log(res.statusCode); socket.destroy(); process.exit(0); });
    req.on('response', (res) => { console.log(res.statusCode); process.exit(0); });
    req.on('error', (e) => { console.log('ERR ' + e.message); process.exit(0); });
    req.end();
    setTimeout(() => { console.log('TIMEOUT'); process.exit(0); }, 5000);
  `;
  return new Promise((resolve, reject) => {
    execFile('node', ['-e', script, url, opts.origin ?? ''], (err, stdout) => {
      const out = stdout.trim();
      if (err || !/^\d+$/.test(out)) return reject(new Error(`handshake probe failed: ${out || err?.message}`));
      resolve(Number(out));
    });
  });
}

describe('handshake authentication', () => {
  it('accepts a valid single-use ticket and says hello', async () => {
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    await c.until((e) => e.type === 'start');
    c.close();
  });
  it('rejects: no ticket, garbage, access token, reused ticket (401)', async () => {
    expect(await handshakeStatus(wsUrl('/api/v1/ws'))).toBe(401);
    expect(await handshakeStatus(wsUrl('/api/v1/ws', 'garbage'))).toBe(401);
    expect(await handshakeStatus(wsUrl('/api/v1/ws', alice.token!))).toBe(401);
    const t = await ticket();
    expect(await handshakeStatus(wsUrl('/api/v1/ws', t))).toBe(101);
    expect(await handshakeStatus(wsUrl('/api/v1/ws', t))).toBe(401);
  });
  it('refuses upgrades on other paths', async () => {
    expect([400, 404]).toContain(await handshakeStatus(wsUrl('/other', await ticket())));
  });
  it('blocks cross-site WebSocket hijacking via the Origin allowlist (403) but allows listed and header-less clients', async () => {
    expect(await handshakeStatus(wsUrl('/api/v1/ws', await ticket()), { origin: 'https://evil.example' })).toBe(403);
    expect(await handshakeStatus(wsUrl('/api/v1/ws', await ticket()), { origin: 'http://localhost:3000' })).toBe(101);
    expect(await handshakeStatus(wsUrl('/api/v1/ws', await ticket()))).toBe(101);
  });
});

describe('chat over WebSocket', () => {
  it('streams a full turn and persists it for the authenticated user', async () => {
    const id = await session();
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    c.send({ type: 'chat', sessionId: id, text: 'hello over ws' });
    const done = await c.until((e) => e.type === 'done');
    expect(done.payload).toMatchObject({ sessionId: id, status: 'completed', fullResponse: 'WS reply.' });
    expect(c.events.filter((e) => e.type === 'token').map((e) => e.payload.token).join('')).toBe('WS reply.');
    const msgs = (await alice.json('GET', `/api/v1/chat/sessions/${id}/messages`)).body.messages;
    expect(msgs.map((m: any) => m.content)).toEqual(['hello over ws', 'WS reply.']);
    c.close();
  });

  it('a connection can run several turns in sequence', async () => {
    const id = await session();
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    for (let i = 0; i < 2; i++) {
      c.events.length = 0;
      c.send({ type: 'chat', sessionId: id, text: `turn ${i}` });
      await c.until((e) => e.type === 'done');
    }
    expect((await alice.json('GET', `/api/v1/chat/sessions/${id}/messages`)).body.messages).toHaveLength(4);
    c.close();
  });

  it("OWNERSHIP: cannot chat in another user's session (error event, nothing written)", async () => {
    const bob = new ApiClient(h.server.url); await bob.signup(`wsb${++n}@test.dev`);
    const bobSession = await session(bob);
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    c.send({ type: 'chat', sessionId: bobSession, text: 'let me in' });
    const err = await c.until((e) => e.type === 'error');
    expect(err.payload.code).toBe('not_found');
    expect((await bob.json('GET', `/api/v1/chat/sessions/${bobSession}/messages`)).body.messages).toEqual([]);
    c.close();
  });

  it('reports invalid messages without dropping the connection', async () => {
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    for (const bad of ['not json', '{}', JSON.stringify({ type: 'chat', sessionId: 'nope', text: 'x' }), JSON.stringify({ type: 'chat', sessionId: await session(), text: '' }), JSON.stringify({ type: 'hack' })]) {
      c.events.length = 0;
      c.send(bad);
      expect((await c.until((e) => e.type === 'error')).payload.code).toBe('validation_error');
    }
    c.send({ type: 'ping' });
    await c.until((e) => e.type === 'pong');
    c.close();
  });

  it('rejects over-long messages', async () => {
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    c.send({ type: 'chat', sessionId: await session(), text: 'x'.repeat(4001) });
    expect((await c.until((e) => e.type === 'error')).payload.code).toBe('validation_error');
    c.close();
  });

  it('closes connections that send oversized frames (64KB cap)', async () => {
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
    c.send('x'.repeat(70_000));
    expect(await closed).toBe(1009);
  });

  it('rate-limits messages per connection', async () => {
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    for (let i = 0; i < 14; i++) c.send({ type: 'ping' });
    expect((await c.until((e) => e.type === 'error' && e.payload.code === 'rate_limited')).payload.code).toBe('rate_limited');
    c.close();
  });

  it('DEGRADES: model outage yields an error event and the connection stays usable', async () => {
    const id = await session();
    const c = await connect(wsUrl('/api/v1/ws', await ticket()));
    h.model.available = false;
    c.send({ type: 'chat', sessionId: id, text: 'anyone?' });
    expect((await c.until((e) => e.type === 'error')).payload.code).toBe('model_unavailable');
    await c.until((e) => e.type === 'done');
    h.model.available = true;
    c.events.length = 0;
    c.send({ type: 'chat', sessionId: id, text: 'back?' });
    expect((await c.until((e) => e.type === 'done')).payload.status).toBe('completed');
    c.close();
  });
});

describe('cancellation & disconnects propagate to the work', () => {
  const callSlow = [{ toolCalls: [{ name: 'slow_tool', args: {} }] }, { text: 'never reached' }];
  let local: TestHarness;
  const localSlow = new SlowTool();
  beforeAll(async () => {
    local = await startTestApp({ script: callSlow, repeatLast: false, env: { SSE_HEARTBEAT_MS: '50' } });
    local.deps.registry.register(localSlow);
  });
  afterAll(() => local.close());

  async function setup() {
    const c = new ApiClient(local.server.url); await c.signup(`cancel${++n}@test.dev`);
    const id = (await c.json('POST', '/api/v1/chat/sessions', { json: {} })).body.session.id as string;
    localSlow.reset();
    local.model.createChatModel; // script is re-created per run via factory below
    return { c, id };
  }
  const freshProvider = () => { (local.model as any).script = callSlow; };

  it('{type:"cancel"} aborts the running tool and ends the turn as interrupted', async () => {
    const { c, id } = await setup();
    freshProvider();
    const ticket2 = (await c.json('POST', '/api/v1/auth/stream-ticket', { json: {} })).body.ticket;
    const ws = await connect(`ws://127.0.0.1:${local.server.port}/api/v1/ws?ticket=${ticket2}`);
    ws.send({ type: 'chat', sessionId: id, text: 'do the slow thing' });
    await localSlow.started;
    ws.send({ type: 'cancel' });
    const done = await ws.until((e) => e.type === 'done');
    expect(done.payload.status).toBe('interrupted');
    expect(localSlow.sawAbort).toBe(true);
    expect(local.deps.chat.isBusy(id)).toBe(false);
    const msgs = (await c.json('GET', `/api/v1/chat/sessions/${id}/messages`)).body.messages;
    expect(msgs.at(-1).metadata.status).toBe('interrupted');
    ws.close();
  });

  it('closing the socket mid-turn aborts the tool (no orphaned work) and frees the session', async () => {
    const { c, id } = await setup();
    freshProvider();
    const ticket2 = (await c.json('POST', '/api/v1/auth/stream-ticket', { json: {} })).body.ticket;
    const ws = await connect(`ws://127.0.0.1:${local.server.port}/api/v1/ws?ticket=${ticket2}`);
    ws.send({ type: 'chat', sessionId: id, text: 'do the slow thing' });
    await localSlow.started;
    ws.close();
    for (let i = 0; i < 100 && !localSlow.sawAbort; i++) await new Promise((r) => setTimeout(r, 20));
    expect(localSlow.sawAbort).toBe(true);
    for (let i = 0; i < 100 && local.deps.chat.isBusy(id); i++) await new Promise((r) => setTimeout(r, 20));
    expect(local.deps.chat.isBusy(id)).toBe(false);
  });

  it('an SSE client disconnecting mid-turn (real process killed) aborts the tool and saves the partial reply as interrupted', async () => {
    const { c, id } = await setup();
    freshProvider();
    const client = spawnStreamingClient(`${local.server.url}/api/v1/chat/sessions/${id}/messages`, c.token!, { text: 'slow please' });
    await client.ready;
    await localSlow.started;
    client.kill(); // abrupt TCP close, like closing the browser tab
    for (let i = 0; i < 150 && !localSlow.sawAbort; i++) await new Promise((r) => setTimeout(r, 20));
    expect(localSlow.sawAbort).toBe(true);
    for (let i = 0; i < 100 && local.deps.chat.isBusy(id); i++) await new Promise((r) => setTimeout(r, 20));
    expect(local.deps.chat.isBusy(id)).toBe(false);
    const msgs = (await c.json('GET', `/api/v1/chat/sessions/${id}/messages`)).body.messages;
    expect(msgs[0]).toMatchObject({ sender: 'user', content: 'slow please' });
    expect(msgs.at(-1).metadata.status).toBe('interrupted');
  });
});
