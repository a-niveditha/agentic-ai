import type { Request, Response } from 'express';

export interface SseChannel {
  send(event: unknown): void;
  /** Aborts when the client goes away (or `abort()` is called). */
  signal: AbortSignal;
  close(): void;
  readonly open: boolean;
}

/**
 * Starts a Server-Sent-Events response. A heartbeat comment keeps proxies from idling the stream out, and a
 * client disconnect aborts `signal` so downstream work (model calls, tools) stops instead of running on.
 */
export function openSse(req: Request, res: Response, options: { heartbeatMs?: number } = {}): SseChannel {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  let open = true;
  const cleanup = () => {
    open = false;
    clearInterval(heartbeat);
    // Keep-alive sockets outlive the response: don't leave our listeners behind on them.
    req.socket?.off('close', gone);
    req.socket?.off('error', gone);
  };
  // Runtimes differ in which disconnect event fires (Bun emits none once the request body was read), so the
  // heartbeat doubles as a liveness probe: a destroyed socket, a vanished peer address, or a failed write
  // all mean the client is gone.
  const hadPeer = Boolean(req.socket?.remoteAddress);
  const heartbeat = setInterval(() => {
    if (!open) return;
    if (res.destroyed || req.socket?.destroyed || (hadPeer && !req.socket?.remoteAddress)) return gone();
    try {
      res.write(': keep-alive\n\n');
    } catch {
      gone();
    }
  }, options.heartbeatMs ?? 10_000);
  heartbeat.unref?.();
  // Node emits res 'close' on disconnect; Bun emits req 'aborted' / socket 'close' instead. Listen to all three
  // (req 'close' is avoided: on Node it fires as soon as the request body has been read).
  function gone() {
    if (!res.writableEnded && !controller.signal.aborted) controller.abort();
    cleanup();
  }
  res.once('close', gone);
  res.once('error', gone);
  req.once('aborted', gone);
  req.socket?.once('close', gone);
  req.socket?.once('error', gone);

  return {
    send(event) {
      if (open && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    signal: controller.signal,
    close() {
      if (!res.writableEnded) res.end();
      cleanup();
    },
    get open() {
      return open;
    },
  };
}
