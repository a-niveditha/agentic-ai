"use client";

import { useState } from "react";
import { AlertTriangle, Check, Clock3, FileText, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { Button, Notice } from "@/components/ui";
import { useDeleteDocument, useRetryDocument } from "./knowledgeApi";
import type { KnowledgeDocument } from "./knowledgeTypes";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function canRestart(doc: KnowledgeDocument) {
  return doc.status === "failed" || Date.now() - new Date(doc.updatedAt).getTime() > 5 * 60 * 1000;
}

function Status({ doc }: { doc: KnowledgeDocument }) {
  if (doc.status === "ready") return <span className="inline-flex items-center gap-1 rounded-full bg-mint px-2.5 py-1 text-[11px] font-medium text-moss"><Check size={12} />Ready</span>;
  if (doc.status === "processing") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800"><LoaderCircle size={12} className="animate-spin" />Indexing</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-700"><AlertTriangle size={12} />Needs attention</span>;
}

export function DocumentList({ documents }: { documents: KnowledgeDocument[] }) {
  const retry = useRetryDocument();
  const remove = useDeleteDocument();
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  async function retryDoc(doc: KnowledgeDocument) {
    setError("");
    setBusyId(doc.id);
    try { await retry.mutateAsync(doc.id); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not restart indexing."); }
    finally { setBusyId(""); }
  }

  async function deleteDoc(doc: KnowledgeDocument) {
    if (!window.confirm("Remove “" + doc.filename + "” from your knowledge base?")) return;
    setError("");
    setBusyId(doc.id);
    try { await remove.mutateAsync(doc.id); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not remove the document."); }
    finally { setBusyId(""); }
  }

  return (
    <section className="rounded-[24px] border border-line bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-5 flex items-end justify-between"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-moss">Your library</p><h2 className="mt-1 text-xl font-semibold tracking-tight">Knowledge base</h2></div><span className="rounded-full bg-[#f1f4ef] px-3 py-1 text-xs text-muted">{documents.length} {documents.length === 1 ? "source" : "sources"}</span></div>
      {error && <div className="mb-4"><Notice>{error}</Notice></div>}
      {!documents.length ? <div className="rounded-2xl border border-dashed border-line px-5 py-12 text-center"><FileText className="mx-auto mb-3 text-[#9ba69e]" size={24} /><p className="text-sm font-medium text-ink">Your library is empty</p><p className="mt-1 text-xs text-muted">Add a source to give your assistant context.</p></div> :
        <div className="divide-y divide-line">
          {documents.map((doc) => <article key={doc.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f2f5f0] text-muted"><FileText size={18} /></span>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="max-w-full truncate text-sm font-semibold text-ink">{doc.filename}</h3><Status doc={doc} /></div><p className="mt-1 flex items-center gap-1 text-xs text-muted"><Clock3 size={12} />Added {dateLabel(doc.createdAt)}{doc.status === "ready" ? " · " + doc.chunksCount + " indexed chunks" : ""}</p>{doc.sourceUrl && <a href={doc.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 block truncate text-xs text-moss hover:underline">{doc.sourceUrl}</a>}{doc.errorMessage && <p className="mt-1 text-xs leading-5 text-red-700">{doc.errorMessage}</p>}</div>
            <div className="flex shrink-0 gap-2">
              {canRestart(doc) && <Button variant="secondary" className="px-3 py-2 text-xs" onClick={() => void retryDoc(doc)} disabled={busyId === doc.id}><RefreshCw size={13} />{doc.status === "processing" ? "Restart" : "Retry"}</Button>}
              <Button variant="ghost" aria-label={"Delete " + doc.filename} className="px-3 py-2 text-xs text-red-700" onClick={() => void deleteDoc(doc)} disabled={busyId === doc.id}><Trash2 size={14} /></Button>
            </div>
          </article>)}
        </div>}
    </section>
  );
}
