"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/apiClient";
import type { StreamEvent } from "@/lib/readSse";
import { chatKeys, streamMessage } from "./chatApi";
import type { ChatMessage, Citation, LiveTool, TurnDraft } from "./chatTypes";

export function useChatStream(sessionId: string) {
  const client = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<TurnDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState("");

  const handleEvent = useCallback((event: StreamEvent) => {
    const payload = event.payload || {};
    if (event.type === "token") {
      setDraft((old) => old ? { ...old, content: old.content + String(payload.token || "") } : old);
    } else if (event.type === "citation") {
      const citations = (payload.citations || []) as Citation[];
      setDraft((old) => old ? { ...old, citations: [...old.citations, ...citations] } : old);
    } else if (event.type === "tool_start") {
      const tool: LiveTool = { id: String(payload.id), tool: String(payload.tool), input: payload.input };
      setDraft((old) => old ? { ...old, tools: [...old.tools, tool] } : old);
    } else if (event.type === "tool_end") {
      setDraft((old) => old ? {
        ...old,
        tools: old.tools.map((tool) => tool.id === payload.id ? { ...tool, output: payload.output, success: Boolean(payload.success) } : tool),
      } : old);
    } else if (event.type === "error") {
      setDraft((old) => old ? { ...old, error: String(payload.message || "The reply could not be completed.") } : old);
    } else if (event.type === "done") {
      setDraft((old) => old ? { ...old, status: String(payload.status || "completed") } : old);
    }
  }, []);

  const send = useCallback(async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setRequestError("");
    setDraft({ content: "", citations: [], tools: [] });
    const optimistic: ChatMessage = {
      id: "optimistic-" + Date.now(),
      sessionId,
      sender: "user",
      content: text.trim(),
      createdAt: new Date().toISOString(),
      metadata: null,
    };
    client.setQueryData<ChatMessage[]>(chatKeys.messages(sessionId), (old) => [...(old || []), optimistic]);
    const abort = new AbortController();
    controller.current = abort;
    try {
      await streamMessage(sessionId, text.trim(), abort.signal, handleEvent);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setRequestError(error instanceof ApiError ? error.message : "The connection was interrupted. Your conversation will reload.");
      }
    } finally {
      controller.current = null;
      setBusy(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: chatKeys.messages(sessionId) }),
        client.invalidateQueries({ queryKey: chatKeys.sessions }),
      ]);
      setDraft(null);
    }
  }, [busy, client, handleEvent, sessionId]);

  const cancel = useCallback(() => controller.current?.abort(), []);
  return { draft, busy, requestError, send, cancel, clearError: () => setRequestError("") };
}
