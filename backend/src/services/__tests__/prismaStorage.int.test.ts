import { afterAll, beforeAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaStorageAdapter } from '../PrismaStorageAdapter.js';
import { describeStorageContract } from './storageContract.js';

const backendDir = resolve(import.meta.dir, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'prisma-int-'));
const dbUrl = `file:${join(dir, 'test.db')}`;
let prisma: PrismaClient;

beforeAll(() => {
  // Real SQLite database created from the real schema (never the developer's dev.db).
  execFileSync('bunx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], { cwd: backendDir, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: 'pipe' });
  prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describeStorageContract('PrismaStorageAdapter (SQLite)', async () => ({
  storage: new PrismaStorageAdapter(prisma),
  cleanup: async () => {
    await prisma.chatMessage.deleteMany();
    await prisma.chatSession.deleteMany();
    await prisma.document.deleteMany();
    await prisma.user.deleteMany();
  },
}));
