import { describe, expect, it } from 'bun:test';
import { InMemoryStorageAdapter } from '../InMemoryStorageAdapter.js';
import { describeStorageContract } from './storageContract.js';

describeStorageContract('InMemoryStorageAdapter', async () => ({ storage: new InMemoryStorageAdapter() }));

describe('InMemoryStorageAdapter failure simulation', () => {
  it('failWith simulates a database outage on every operation and reports down', async () => {
    const s = new InMemoryStorageAdapter();
    const u = await s.createUser('x@test.dev', 'h', 'X');
    s.failWith = new Error('db down');
    await expect(s.listSessions(u.id)).rejects.toThrow('db down');
    await expect(s.createDocument(u.id, { filename: 'a', mimeType: 'text/plain' })).rejects.toThrow('db down');
    expect((await s.checkHealth()).status).toBe('down');
    s.failWith = undefined;
    expect((await s.checkHealth()).status).toBe('up');
  });
});
