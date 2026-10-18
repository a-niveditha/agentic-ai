"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { Button, Notice } from "@/components/ui";
import { AddDocumentForm } from "./AddDocumentForm";
import { DocumentList } from "./DocumentList";
import { useDocuments } from "./knowledgeApi";

export function KnowledgeBasePage() {
  const query = useDocuments();
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="max-w-2xl"><p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">Sources & context</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Knowledge base</h1><p className="mt-2 text-sm leading-6 text-muted">Add the documents and webpages you want your assistant to draw on. Indexing happens in the background.</p></header>
      {query.isError && <Notice><span className="inline-flex items-center gap-2"><AlertCircle size={15} />{query.error.message}</span><Button variant="secondary" className="ml-3 px-3 py-1.5" onClick={() => void query.refetch()}><RefreshCw size={13} />Retry</Button></Notice>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <AddDocumentForm extensions={query.data?.supportedExtensions || []} />
        {query.isPending ? <div className="grid min-h-64 place-items-center rounded-[24px] border border-line bg-white text-sm text-muted">Loading your sources…</div> : <DocumentList documents={query.data?.documents || []} />}
      </div>
      {query.data?.documents.some((doc) => doc.status === "processing") && <p className="flex items-center gap-2 text-xs text-muted"><RefreshCw size={12} className="animate-spin" />Refreshing while sources are being indexed.</p>}
    </div>
  );
}
