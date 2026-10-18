'use client';

import React, { useState } from 'react';
import { ingestDocument } from '../lib/api';
import { BookOpen, FileText, Upload, CheckCircle2 } from 'lucide-react';

export const KnowledgeBaseManager: React.FC = () => {
  const [filename, setFilename] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setLoading(true);
    try {
      const res = await ingestDocument(content, filename || 'custom_document.md');
      setResult(res);
      setContent('');
      setFilename('');
    } catch (err: any) {
      setResult({ error: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-6">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center">
          <BookOpen className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">Knowledge Base Manager</h2>
          <p className="text-xs text-slate-400">Ingest text & markdown files into the RAG vector store for instant retrieval.</p>
        </div>
      </div>

      <form onSubmit={handleIngest} className="space-y-4">
        <div>
          <label className="block text-xs font-mono text-slate-300 mb-1">Document Title / Filename</label>
          <input
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="e.g. system-architecture.md"
            className="w-full bg-slate-900/90 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500/50"
          />
        </div>

        <div>
          <label className="block text-xs font-mono text-slate-300 mb-1">Text Content to Index</label>
          <textarea
            rows={5}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste text content or documentation to chunk and embed..."
            className="w-full bg-slate-900/90 border border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500/50"
          />
        </div>

        <button
          type="submit"
          disabled={loading || !content.trim()}
          className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:opacity-90 disabled:opacity-50 text-white text-xs font-semibold py-3 rounded-xl flex items-center justify-center gap-2 shadow-glow-purple transition-all"
        >
          <Upload className="h-4 w-4" />
          {loading ? 'Chunking & Embedding...' : 'Ingest into RAG Vector Store'}
        </button>
      </form>

      {result && (
        <div className={`p-4 rounded-xl border text-xs ${result.success ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-rose-500/10 border-rose-500/20 text-rose-300'}`}>
          <div className="flex items-center gap-2 font-bold mb-1">
            <CheckCircle2 className="h-4 w-4" />
            {result.success ? 'Ingestion Successful' : 'Ingestion Error'}
          </div>
          {result.success && <p>Chunks Indexed: {result.chunksIndexed}</p>}
          {result.error && <p>{result.error}</p>}
        </div>
      )}
    </div>
  );
};
