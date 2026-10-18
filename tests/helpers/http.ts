import { createServer, type RequestListener, type Server } from 'node:http';

export interface RunningServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

export async function listen(handler: RequestListener, existing?: Server): Promise<RunningServer> {
  const server = existing ?? createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port as number;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    close: () => new Promise<void>((resolve) => { (server as any).closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export interface SseEvent {
  type: string;
  payload: any;
  timestamp?: number;
}

/** Reads a whole text/event-stream response into parsed events (ignores heartbeat comments). */
export async function readSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

export const tokensOf = (events: SseEvent[]) => events.filter((e) => e.type === 'token').map((e) => e.payload.token).join('');
export const ofType = (events: SseEvent[], type: string) => events.filter((e) => e.type === type);

export class ApiClient {
  token?: string;
  constructor(public readonly base: string) {}

  async request(method: string, path: string, opts: { json?: unknown; form?: FormData; headers?: Record<string, string>; auth?: boolean | string } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const token = typeof opts.auth === 'string' ? opts.auth : opts.auth === false ? undefined : this.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: any;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) body = opts.form;
    return fetch(`${this.base}${path}`, { method, headers, body });
  }

  async json<T = any>(method: string, path: string, opts?: Parameters<ApiClient['request']>[2]): Promise<{ status: number; body: T; headers: Headers }> {
    const res = await this.request(method, path, opts);
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, headers: res.headers };
  }

  async signup(email: string, password = 'correct-horse-battery', name = 'Test User') {
    const r = await this.json('POST', '/api/v1/auth/signup', { json: { email, password, name }, auth: false });
    if (r.status === 201) this.token = r.body.token;
    return r;
  }

  /** Polls until the document is no longer `processing` (indexing runs in the background) and returns it. */
  async waitForDocument(id: string, timeoutMs = 120_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.json('GET', `/api/v1/documents/${id}`);
      if (r.status !== 200) throw new Error(`document ${id}: HTTP ${r.status}`);
      if (r.body.document.status !== 'processing') return r.body.document;
      if (Date.now() > deadline) throw new Error(`document ${id} still processing after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Polls until none of the user's documents is `processing`; returns the list. */
  async waitForIndexing(timeoutMs = 120_000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const docs = (await this.json('GET', '/api/v1/documents')).body.documents as any[];
      if (!docs.some((d) => d.status === 'processing')) return docs;
      if (Date.now() > deadline) throw new Error(`documents still processing after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Uploads a file, asserts it was accepted (202) and waits for indexing. Returns the settled document. */
  async uploadAndWait(filename: string, buffer: Buffer, mimeType: string): Promise<any> {
    const r = await this.upload(filename, buffer, mimeType);
    if (r.status !== 202) throw new Error(`upload ${filename}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    return this.waitForDocument(r.body.document.id);
  }

  upload(filename: string, buffer: Buffer, mimeType: string) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
    return this.json('POST', '/api/v1/documents', { form });
  }
}
