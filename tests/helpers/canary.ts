import http from 'node:http';

/** A local HTTP server that records every request. Used to prove that blocked SSRF targets are never contacted. */
export async function startCanary() {
  const hits: { method?: string; url?: string; host?: string }[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('CANARY-SECRET-INTERNAL-DATA');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port as number;
  return { port, hits, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
