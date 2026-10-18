"use client";

import { useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, BookOpen, LoaderCircle, Square } from "lucide-react";
import { Button, Field, Notice, Textarea } from "@/components/ui";
import { CitationList } from "@/features/shared/CitationList";
import { useRagQuery } from "./useRagQuery";

const markdownPlugins = [remarkGfm];
const statusText: Record<string, string> = {
  completed: "Answer grounded in your sources",
  degraded: "Showing retrieved passages because the model is unavailable",
  no_context: "No relevant passages found",
  interrupted: "Answer stopped",
  unavailable: "Knowledge base unavailable",
};

export function RagPage() {
  const [question, setQuestion] = useState("");
  const [topK, setTopK] = useState(4);
  const rag = useRagQuery();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (question.trim() && !rag.busy) void rag.ask(question.trim(), topK);
  }
  return (
    <div className="mx-auto max-w-5xl space-y-7">
      <header className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">Grounded answers</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Ask your library</h1><p className="mt-2 text-sm leading-6 text-muted">Search your indexed sources for a focused answer. This page doesn’t use chat history or web tools.</p></header>
      <form onSubmit={submit} className="rounded-[24px] border border-line bg-white p-5 shadow-sm sm:p-7">
        <Field label="What would you like to know?"><Textarea rows={4} maxLength={4000} required value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a question about the sources in your library…" /></Field>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <Field label="Sources to retrieve"><select value={topK} onChange={(event) => setTopK(Number(event.target.value))} className="rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink">{Array.from({ length: 10 }, (_, index) => index + 1).map((n) => <option key={n} value={n}>{n} passages</option>)}</select></Field>
          {rag.busy ? <Button type="button" variant="secondary" onClick={rag.cancel}><Square size={13} />Stop</Button> : <Button type="submit" disabled={!question.trim()}><ArrowUp size={16} />Ask</Button>}
        </div>
      </form>
      {rag.result && <section aria-live="polite" className="rounded-[24px] border border-line bg-white p-5 shadow-sm sm:p-7">
        <div className="mb-5 flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-mint text-moss"><BookOpen size={18} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase tracking-[0.15em] text-moss">{rag.result.status ? statusText[rag.result.status] || rag.result.status : "Answering"}</p><p className="mt-1 text-sm font-medium text-ink">{rag.result.question}</p></div>{rag.busy && <LoaderCircle size={17} className="animate-spin text-moss" />}</div>
        {rag.result.error && <div className="mb-4"><Notice>{rag.result.error}</Notice></div>}
        {rag.result.answer && <div className="markdown-content"><ReactMarkdown remarkPlugins={markdownPlugins}>{rag.result.answer}</ReactMarkdown></div>}
        {!rag.result.answer && rag.busy && <p className="text-sm text-muted">Searching your sources…</p>}
        <CitationList citations={rag.result.citations} />
      </section>}
    </div>
  );
}
