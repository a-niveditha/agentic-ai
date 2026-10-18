import { Document } from '@langchain/core/documents';
import { BaseRetriever, type BaseRetrieverInput } from '@langchain/core/retrievers';
import { assertUserId } from '../stores/tenantGuard.js';
import type { Citation, RAGDocumentMetadata, SearchResult, VectorStoreAdapter } from '../types.js';

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
  /** Approximate token budget for the returned text (1 token ~ 4 chars). */
  maxTokens?: number;
}

export const MAX_TOP_K = 10;

/** Metadata that is safe to hand to the model / API clients (no tenant ids or hashes). */
export function publicMetadata(meta: RAGDocumentMetadata): Record<string, string | number | boolean> {
  const { userId: _u, contentHash: _h, docHash: _d, ...rest } = meta;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;
}

export function toCitation(result: SearchResult): Citation {
  const m = result.document.metadata;
  return {
    title: m.title || m.sourceUrl || 'Document',
    source: m.sourceUrl || m.title || 'Knowledge Base',
    content: result.document.pageContent,
    sourceId: m.sourceId,
    url: m.sourceUrl,
    ...(m.page !== undefined ? { page: m.page } : {}),
    ...(m.section ? { section: m.section } : {}),
  };
}

export function applyBudget(results: SearchResult[], maxTokens?: number): SearchResult[] {
  if (!maxTokens) return results;
  const maxChars = maxTokens * 4;
  const out: SearchResult[] = [];
  let used = 0;
  for (const r of results) {
    if (used + r.document.pageContent.length > maxChars) break;
    out.push(r);
    used += r.document.pageContent.length;
  }
  return out;
}

export interface TenantRetrieverInput extends BaseRetrieverInput, RetrieveOptions {
  store: VectorStoreAdapter;
  /** Trusted tenant identity; bound at construction and never taken from the query. */
  userId: string;
}

/** LangChain retriever bound to exactly one tenant. */
export class TenantRetriever extends BaseRetriever {
  static lc_name() {
    return 'TenantRetriever';
  }
  lc_namespace = ['agentic_ai', 'rag', 'retriever'];
  private readonly store: VectorStoreAdapter;
  private readonly userId: string;
  private readonly options: RetrieveOptions;

  constructor(input: TenantRetrieverInput) {
    super(input);
    assertUserId(input.userId);
    this.store = input.store;
    this.userId = input.userId;
    this.options = { topK: input.topK, minScore: input.minScore, maxTokens: input.maxTokens };
  }

  async search(query: string, override: RetrieveOptions = {}): Promise<SearchResult[]> {
    const opts = { ...this.options, ...override };
    const k = Math.min(Math.max(1, Math.floor(opts.topK ?? 4)), MAX_TOP_K);
    let results = await this.store.similaritySearch(query, k, { userId: this.userId });
    if (opts.minScore && opts.minScore > 0) results = results.filter((r) => r.score >= opts.minScore!);
    return applyBudget(results, opts.maxTokens);
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    const results = await this.search(query);
    return results.map(
      (r) => new Document({ pageContent: r.document.pageContent, metadata: { ...publicMetadata(r.document.metadata), score: r.score } }),
    );
  }
}
