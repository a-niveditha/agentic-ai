'use client';

import React from 'react';
import { TransportMode } from '../lib/streamHook';
import { Cpu, Network, Zap } from 'lucide-react';

interface HeaderProps {
  transportMode: TransportMode;
  setTransportMode: (mode: TransportMode) => void;
  health: { backend: any } | null;
}

export const Header: React.FC<HeaderProps> = ({ transportMode, setTransportMode, health }) => {
  const isServerOnline = !!health?.backend;

  return (
    <header className="glass-panel sticky top-0 z-50 border-b border-slate-800/80 px-6 py-4">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-cyan-500 via-indigo-500 to-purple-600 flex items-center justify-center shadow-glow">
            <Cpu className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              Agentic AI <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono">100% TS</span>
            </h1>
            <p className="text-xs text-slate-400 font-mono">Unified Backend • LangChain TS • RAG Engine • MCP Server</p>
          </div>
        </div>

        {/* Server Health & Transport Switcher */}
        <div className="flex items-center gap-4">
          {/* Health Badge */}
          <div className="flex items-center gap-2 text-xs font-mono">
            <div className={`px-2.5 py-1 rounded-lg flex items-center gap-1.5 border ${isServerOnline ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border-rose-500/20'}`}>
              <span className={`h-2 w-2 rounded-full ${isServerOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
              Unified Server (5000)
            </div>
          </div>

          {/* Transport Mode Toggle */}
          <div className="flex items-center bg-slate-900/80 p-1 rounded-xl border border-slate-800 text-xs font-medium">
            <button
              onClick={() => setTransportMode('sse')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${transportMode === 'sse' ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <Zap className="h-3.5 w-3.5" />
              HTTPS SSE
            </button>
            <button
              onClick={() => setTransportMode('ws')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${transportMode === 'ws' ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <Network className="h-3.5 w-3.5" />
              WebSocket (WS)
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
