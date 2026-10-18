import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { createEvent } from '@agentic-ai/agent';
import { API_BASE } from '../config/api.js';
import { AppError } from '../lib/errors.js';
import type { Dependencies } from '../container.js';

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat'), sessionId: z.string().uuid(), text: z.string().trim().min(1) }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('ping') }),
]);

export interface WsOptions {
  path?: string;
  /** Messages allowed per connection per window. */
  maxMessagesPerWindow?: number;
  windowMs?: number;
  heartbeatMs?: number;
}

/**
 * WebSocket chat transport. The handshake is authenticated BEFORE the connection exists: a valid single-use
 * `?ticket=` is required (browsers cannot set headers on WebSockets), and a browser `Origin` must be on the
 * CORS allowlist (blocks cross-site WebSocket hijacking). Rejection goes through `verifyClient`, which sends a
 * proper HTTP error on both Node and Bun.
 */
export function attachWebSocketServer(httpServer: HttpServer, deps: Dependencies, options: WsOptions = {}): WebSocketServer {
  const path = options.path ?? `${API_BASE}/ws`;
  const windowMs = options.windowMs ?? 10_000;
  const maxMessages = options.maxMessagesPerWindow ?? 10;
  const MAX_PAYLOAD = 64 * 1024;

  const wss = new WebSocketServer({
    server: httpServer,
    path,
    maxPayload: MAX_PAYLOAD,
    verifyClient: (info: { origin: string; req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
      const origin = info.req.headers.origin;
      if (origin && !deps.config.corsOrigins.includes(origin)) return done(false, 403, 'Forbidden');
      try {
        const url = new URL(info.req.url ?? '/', 'http://localhost');
        (info.req as IncomingMessage & { userId?: string }).userId = deps.tokens.consumeTicket(url.searchParams.get('ticket') ?? '').userId;
      } catch {
        return done(false, 401, 'Unauthorized');
      }
      done(true);
    },
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage & { userId?: string }) => {
    const userId = req.userId!;
    let alive = true;
    let controller: AbortController | undefined;
    let recent: number[] = [];
    const send = (event: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(event));

    ws.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, options.heartbeatMs ?? 30_000);
    heartbeat.unref?.();

    send(createEvent('start', { message: 'connected' }));

    ws.on('message', async (raw) => {
      // Enforced here as well as via maxPayload so the cap holds on every runtime.
      if ((raw as Buffer).length > MAX_PAYLOAD) return void ws.close(1009, 'message too big');
      const now = Date.now();
      recent = recent.filter((t) => now - t < windowMs);
      if (recent.length >= maxMessages) return void send(createEvent('error', { message: 'You are sending messages too quickly.', code: 'rate_limited' }));
      recent.push(now);

      let msg: z.infer<typeof ClientMessage>;
      try {
        msg = ClientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        return void send(createEvent('error', { message: 'Invalid message', code: 'validation_error' }));
      }

      if (msg.type === 'ping') return void send({ type: 'pong', timestamp: Date.now() });
      if (msg.type === 'cancel') return void controller?.abort();

      if (controller) return void send(createEvent('error', { message: 'A response is already being generated.', code: 'session_busy' }));
      if (msg.text.length > deps.config.MAX_MESSAGE_CHARS) return void send(createEvent('error', { message: 'Message is too long.', code: 'validation_error' }));

      controller = new AbortController();
      try {
        await deps.chat.runChatTurn({ userId, sessionId: msg.sessionId, text: msg.text, signal: controller.signal, onEvent: send });
      } catch (err) {
        const e = err instanceof AppError ? err : null;
        if (!e) deps.logger.error({ err }, 'ws chat turn failed');
        send(createEvent('error', { message: e?.message ?? 'Something went wrong while generating the reply.', code: e?.code ?? 'internal_error' }));
      } finally {
        controller = undefined;
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      controller?.abort(); // stop model/tool work for a client that is gone
    });
    ws.on('error', () => ws.terminate());
  });

  return wss;
}
