'use client';

import React, { useState, useRef, useEffect } from 'react';
import { StreamMessage } from '../lib/streamHook';
import { Bot, Send, User, Sparkles, Wrench, BookOpen, AlertCircle } from 'lucide-react';

interface ChatInterfaceProps {
  messages: StreamMessage[];
  sendMessage: (prompt: string) => void;
  isStreaming: boolean;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ messages, sendMessage, isStreaming }) => {
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    sendMessage(input);
    setInput('');
  };

  return (
    <div className="flex flex-col h-[650px] glass-panel rounded-2xl border border-slate-800 shadow-2xl overflow-hidden">
      {/* Messages Scroll View */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500">
            <div className="h-16 w-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mb-4 animate-pulse-glow">
              <Bot className="h-8 w-8" />
            </div>
            <h3 className="text-lg font-semibold text-slate-200 mb-2">LangChain TS RAG & Tool Agent</h3>
            <p className="text-sm max-w-md text-slate-400">
              Ask questions about the monorepo architecture, perform math calculations, or trigger RAG vector retrieval.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {['Calculate 128 * 45 + 990', 'What is the agent architecture?', 'Show system CPU and memory'].map((sample) => (
                <button
                  key={sample}
                  onClick={() => sendMessage(sample)}
                  className="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800 hover:border-cyan-500/40 text-xs text-slate-300 transition-all"
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex gap-4 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.sender === 'agent' && (
                <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white shrink-0 shadow-glow">
                  <Bot className="h-5 w-5" />
                </div>
              )}

              <div className={`max-w-[80%] rounded-2xl p-4 text-sm leading-relaxed ${msg.sender === 'user' ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-tr-none shadow-md' : 'glass-card border border-slate-800 text-slate-200 rounded-tl-none'}`}>
                {/* Content */}
                <div className="whitespace-pre-wrap font-sans">{msg.content || (msg.isStreaming ? 'Thinking...' : '')}</div>

                {/* Tool Executions Badge */}
                {msg.toolExecutions && msg.toolExecutions.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-800/80 space-y-2">
                    {msg.toolExecutions.map((t, idx) => (
                      <div key={idx} className="flex items-center justify-between text-xs bg-slate-950/60 p-2 rounded-lg border border-cyan-500/20 font-mono text-cyan-300">
                        <span className="flex items-center gap-1.5">
                          <Wrench className="h-3.5 w-3.5 text-cyan-400" />
                          Tool: <strong className="text-white">{t.tool}</strong>
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {t.output ? '✅ Completed' : '⏳ Running...'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Citations Drawer */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-800/80 space-y-2">
                    <div className="text-xs font-semibold text-purple-300 flex items-center gap-1.5">
                      <BookOpen className="h-3.5 w-3.5 text-purple-400" />
                      Retrieved Knowledge Citations:
                    </div>
                    {msg.citations.map((c, cIdx) => (
                      <div key={cIdx} className="bg-slate-950/80 p-2.5 rounded-lg border border-purple-500/20 text-xs space-y-1">
                        <div className="flex items-center justify-between font-mono text-purple-300 text-[11px]">
                          <span>📄 {c.title}</span>
                          <span className="text-slate-500">{c.source}</span>
                        </div>
                        <p className="text-slate-400 text-[11px] italic">"{c.content}"</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {msg.sender === 'user' && (
                <div className="h-9 w-9 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 shrink-0">
                  <User className="h-5 w-5" />
                </div>
              )}
            </div>
          ))
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input Bar */}
      <form onSubmit={handleSubmit} className="p-4 bg-slate-950/60 border-t border-slate-800 flex gap-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask LangChain Agent or query vector store..."
          disabled={isStreaming}
          className="flex-1 bg-slate-900/90 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition-all"
        />
        <button
          type="submit"
          disabled={isStreaming || !input.trim()}
          className="bg-gradient-to-r from-cyan-500 via-blue-600 to-purple-600 hover:opacity-90 disabled:opacity-50 text-white font-medium px-6 py-3 rounded-xl flex items-center gap-2 shadow-glow transition-all shrink-0"
        >
          {isStreaming ? (
            <Sparkles className="h-4 w-4 animate-spin" />
          ) : (
            <>
              Send
              <Send className="h-4 w-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
};
