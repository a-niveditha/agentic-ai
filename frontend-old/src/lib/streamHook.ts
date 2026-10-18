import { useState, useCallback } from 'react';
import { BACKEND_BASE } from './api';

export interface StreamMessage {
  id: string;
  sender: 'user' | 'agent';
  content: string;
  toolExecutions?: Array<{ tool: string; description?: string; input?: any; output?: any; success?: boolean }>;
  citations?: Array<{ title: string; source: string; content: string }>;
  isStreaming?: boolean;
}

export type TransportMode = 'sse' | 'ws';

export function useAgentStream() {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [transportMode, setTransportMode] = useState<TransportMode>('sse');

  const sendMessage = useCallback(async (prompt: string) => {
    if (!prompt.trim() || isStreaming) return;

    const userMsgId = `user_${Date.now()}`;
    const agentMsgId = `agent_${Date.now()}`;

    const userMsg: StreamMessage = { id: userMsgId, sender: 'user', content: prompt };
    const initialAgentMsg: StreamMessage = {
      id: agentMsgId,
      sender: 'agent',
      content: '',
      toolExecutions: [],
      citations: [],
      isStreaming: true,
    };

    setMessages((prev) => [...prev, userMsg, initialAgentMsg]);
    setIsStreaming(true);

    if (transportMode === 'sse') {
      const url = `${BACKEND_BASE}/api/rag/stream?q=${encodeURIComponent(prompt)}`;
      const eventSource = new EventSource(url);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id !== agentMsgId) return msg;

              if (data.type === 'token') {
                return { ...msg, content: msg.content + data.payload.token };
              }
              if (data.type === 'tool_start') {
                const updatedTools = [...(msg.toolExecutions || []), { tool: data.payload.tool, description: data.payload.description, input: data.payload.input }];
                return { ...msg, toolExecutions: updatedTools };
              }
              if (data.type === 'tool_end') {
                const updatedTools = (msg.toolExecutions || []).map((t) =>
                  t.tool === data.payload.tool ? { ...t, output: data.payload.output, success: data.payload.success } : t
                );
                return { ...msg, toolExecutions: updatedTools };
              }
              if (data.type === 'citation') {
                return { ...msg, citations: data.payload.citations };
              }
              if (data.type === 'done') {
                return { ...msg, isStreaming: false };
              }
              return msg;
            })
          );

          if (data.type === 'done') {
            eventSource.close();
            setIsStreaming(false);
          }
        } catch {
          // ignore
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        setIsStreaming(false);
      };
    } else {
      // WebSocket Streaming
      const ws = new WebSocket('ws://localhost:5000');

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'query', query: prompt }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id !== agentMsgId) return msg;

              if (data.type === 'token') {
                return { ...msg, content: msg.content + data.payload.token };
              }
              if (data.type === 'tool_start') {
                const updatedTools = [...(msg.toolExecutions || []), { tool: data.payload.tool, description: data.payload.description, input: data.payload.input }];
                return { ...msg, toolExecutions: updatedTools };
              }
              if (data.type === 'tool_end') {
                const updatedTools = (msg.toolExecutions || []).map((t) =>
                  t.tool === data.payload.tool ? { ...t, output: data.payload.output, success: data.payload.success } : t
                );
                return { ...msg, toolExecutions: updatedTools };
              }
              if (data.type === 'citation') {
                return { ...msg, citations: data.payload.citations };
              }
              if (data.type === 'done') {
                return { ...msg, isStreaming: false };
              }
              return msg;
            })
          );

          if (data.type === 'done') {
            ws.close();
            setIsStreaming(false);
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        ws.close();
        setIsStreaming(false);
      };
    }
  }, [isStreaming, transportMode]);

  return {
    messages,
    sendMessage,
    isStreaming,
    transportMode,
    setTransportMode,
  };
}
