'use client';

import React, { useState, useEffect } from 'react';
import { appendCustomTool, callMcpRpc, fetchTools } from '../lib/api';
import { Layers, PlusCircle, Wrench, RefreshCw } from 'lucide-react';

export const McpManager: React.FC = () => {
  const [tools, setTools] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [outputText, setOutputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadTools = async () => {
    try {
      const data = await fetchTools();
      if (data.tools) setTools(data.tools);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadTools();
  }, []);

  const handleAppendTool = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !description.trim()) return;

    setLoading(true);
    try {
      const res = await appendCustomTool(name, description, outputText);
      if (res.success) {
        setMessage(`Appended custom tool '${name}' successfully!`);
        setName('');
        setDescription('');
        setOutputText('');
        loadTools();
      }
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center">
            <Layers className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Appendable Tools & MCP Registry</h2>
            <p className="text-xs text-slate-400">Append custom tools at runtime and inspect template MCP tools.</p>
          </div>
        </div>
        <button onClick={loadTools} className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Append Tool Form */}
      <form onSubmit={handleAppendTool} className="bg-slate-950/60 p-4 rounded-xl border border-slate-800 space-y-3">
        <div className="text-xs font-semibold text-cyan-300 flex items-center gap-1.5">
          <PlusCircle className="h-3.5 w-3.5" /> Append Custom Agent Tool
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tool Name (e.g. status_checker)"
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description for LangChain planner"
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
          />
        </div>
        <input
          type="text"
          value={outputText}
          onChange={(e) => setOutputText(e.target.value)}
          placeholder="Tool Execution Response Text"
          className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
        />
        <button
          type="submit"
          disabled={loading || !name.trim()}
          className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:opacity-90 disabled:opacity-50 text-white text-xs font-semibold py-2 rounded-lg transition-all"
        >
          {loading ? 'Appending...' : 'Append Tool to Agent Registry'}
        </button>
      </form>

      {message && <div className="text-xs text-cyan-300 bg-cyan-500/10 p-2.5 rounded-lg border border-cyan-500/20">{message}</div>}

      {/* Active Tools List */}
      <div className="space-y-2">
        <div className="text-xs font-mono text-slate-400">Registered Tools ({tools.length}):</div>
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {tools.map((t) => (
            <div key={t.name} className="glass-card p-3 rounded-xl border border-slate-800/80 flex items-start gap-3">
              <Wrench className="h-4 w-4 text-cyan-400 mt-0.5" />
              <div>
                <div className="text-xs font-bold text-slate-200 font-mono">{t.name}</div>
                <div className="text-[11px] text-slate-400">{t.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
