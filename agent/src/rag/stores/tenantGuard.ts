import type { SearchResult } from '../types.js';

export function assertUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Tenant isolation failure: a non-empty userId is required.');
  }
}

/**
 * Defense in depth: even if a backend ignored the `where` clause, never hand back another tenant's chunk.
 * Returns the safe results and how many foreign chunks were dropped.
 */
export function dropForeignResults(results: SearchResult[], userId: string): { safe: SearchResult[]; dropped: number } {
  const safe = results.filter((r) => r.document.metadata?.userId === userId);
  return { safe, dropped: results.length - safe.length };
}
