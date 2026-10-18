import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

export interface ChromaServer {
  url: string;
  port: number;
  path: string;
  stop(): Promise<void>;
  /** Kill without wiping data (simulates an outage). */
  kill(): Promise<void>;
  /** Start again on the same port + data (recovery). */
  restart(): Promise<void>;
}

/** Starts a REAL Chroma server persisting to disk under data/chroma-test/<name>. Wiped on start. */
export async function startChroma(name = 'default'): Promise<ChromaServer> {
  const path = resolve(ROOT, 'data/chroma-test', name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const port = await freePort();
  const cli = resolve(ROOT, 'agent/node_modules/chromadb/dist/cli.mjs');
  let child: ChildProcess | undefined;

  const boot = async () => {
    child = spawn('node', [cli, 'run', '--path', path, '--port', String(port)], { stdio: 'ignore' });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://localhost:${port}/api/v2/heartbeat`);
        if (r.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('Chroma did not start in time');
  };
  const kill = async () => {
    if (!child) return;
    const c = child;
    child = undefined;
    await new Promise<void>((r) => { c.once('exit', () => r()); c.kill('SIGKILL'); });
  };
  await boot();
  return {
    url: `http://localhost:${port}`,
    port,
    path,
    kill,
    restart: async () => { await kill(); await boot(); },
    stop: async () => { await kill(); rmSync(path, { recursive: true, force: true }); },
  };
}
