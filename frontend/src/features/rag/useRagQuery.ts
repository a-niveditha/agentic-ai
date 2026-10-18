"use client";

import { useRef, useState } from "react";
import { ApiError } from "@/lib/apiClient";
import type { StreamEvent } from "@/lib/readSse";
import { runRagQuery } from "./ragApi";
import type { Citation } from "../shared/CitationList";

export type RagResult = {
  question: string;
  answer: string;
  citations: Citation[];
  status?: string;
  error?: string;
};

export function useRagQuery() {
  const controller = useRef<AbortController | null>(null);
  const [result, setResult] = useState<RagResult | null>(null);
  const [busy, setBusy] = useState(false);

  function onEvent(event: StreamEvent) {
    const payload = event.payload || {};
    if (event.type === "token") {
      setResult((old) => old ? { ...old, answer: old.answer + String(payload.token || "") } : old);
    } else if (event.type === "citation") {
      setResult((old) => old ? { ...old, citations: [...old.citations, ...((payload.citations || []) as Citation[])] } : old);
    } else if (event.type === "error") {
      setResult((old) => old ? { ...old, error: String(payload.message || "The answer could not be completed.") } : old);
    } else if (event.type === "done") {
      setResult((old) => old ? { ...old, status: String(payload.status || "completed"), answer: String(payload.fullResponse || old.answer) } : old);
    }
  }

  async function ask(question: string, topK: number) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setResult({ question, answer: "", citations: [] });
    try {
      await runRagQuery(question, topK, abort.signal, onEvent);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setResult((old) => old ? { ...old, status: "unavailable", error: error instanceof ApiError ? error.message : "Could not reach the knowledge base." } : old);
      }
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  function cancel() {
    controller.current?.abort();
    setResult((old) => old ? { ...old, status: "interrupted" } : old);
  }

  return { result, busy, ask, cancel };
}
