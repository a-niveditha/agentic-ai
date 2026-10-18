import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Integration/e2e tests use the developer's real Gemini key from backend/.env. Never override real env vars.
const envFile = resolve(import.meta.dir, '../../backend/.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"#\n]*)"?\s*$/.exec(line);
    if (m && !process.env[m[1]!] && m[2]!.trim()) process.env[m[1]!] = m[2]!.trim();
  }
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
