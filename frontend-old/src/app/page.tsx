'use client';

import React, { useEffect, useState } from 'react';
import { Header } from '../components/Header';
import { ChatInterface } from '../components/ChatInterface';
import { KnowledgeBaseManager } from '../components/KnowledgeBaseManager';
import { McpManager } from '../components/McpManager';
import { useAgentStream } from '../lib/streamHook';
import { fetchHealth } from '../lib/api';

export default function Home() {
  const { messages, sendMessage, isStreaming, transportMode, setTransportMode } = useAgentStream();
  const [health, setHealth] = useState<{ agent: any; backend: any } | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      const res = await fetchHealth();
      setHealth(res);
    };
    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col font-sans">
      <Header transportMode={transportMode} setTransportMode={setTransportMode} health={health} />

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Streaming Chat Interface (2 cols) */}
        <div className="lg:col-span-2">
          <ChatInterface messages={messages} sendMessage={sendMessage} isStreaming={isStreaming} />
        </div>

        {/* Sidebar Controls & Knowledge Base (1 col) */}
        <div className="space-y-6">
          <KnowledgeBaseManager />
          <McpManager />
        </div>
      </main>
    </div>
  );
}
