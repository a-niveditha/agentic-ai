import { spawn } from 'node:child_process';

/**
 * Starts a real separate OS process that POSTs to `url`, waits for the first streamed bytes, prints READY,
 * then keeps the connection open until killed. Killing it closes the TCP connection exactly like a closed tab.
 */
export function spawnStreamingClient(url: string, token: string, body: unknown) {
  const script = `
    const http = require('http');
    const u = new URL(process.argv[1]);
    const data = process.argv[3];
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false,
      headers: { Authorization: 'Bearer ' + process.argv[2], 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { res.once('data', () => console.log('READY')); res.resume(); });
    req.on('error', () => process.exit(1));
    req.end(data);
    setTimeout(() => process.exit(0), 30000);
  `;
  const child = spawn('node', ['-e', script, url, token, JSON.stringify(body)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d) => { if (String(d).includes('READY')) resolve(); });
    child.on('exit', () => reject(new Error('client exited before READY')));
  });
  return { ready, kill: () => child.kill('SIGKILL') };
}
