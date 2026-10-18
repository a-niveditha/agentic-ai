"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, MessageSquarePlus, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { Button, Input, Notice } from "@/components/ui";
import { useCreateSession, useDeleteSession, useRenameSession, useSessions } from "./chatQueries";

function shortDate(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

export function ConversationList({ activeId, compact = false }: { activeId?: string; compact?: boolean }) {
  const router = useRouter();
  const sessions = useSessions();
  const create = useCreateSession();
  const rename = useRenameSession();
  const remove = useDeleteSession();
  const [renaming, setRenaming] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  function startNew() {
    setError("");
    create.mutate(undefined, {
      onSuccess: (session) => router.push("/chat/" + session.id),
      onError: (err) => setError(err instanceof Error ? err.message : "Could not create a conversation."),
    });
  }

  function saveTitle(event: FormEvent, id: string) {
    event.preventDefault();
    if (!title.trim()) return;
    rename.mutate({ id, title: title.trim() }, {
      onSuccess: () => setRenaming(""),
      onError: (err) => setError(err instanceof Error ? err.message : "Could not rename the conversation."),
    });
  }

  function deleteSession(id: string, name: string) {
    if (!window.confirm("Delete “" + name + "”? This will also remove its messages.")) return;
    remove.mutate(id, {
      onSuccess: () => {
        if (id === activeId) router.push("/chat");
      },
      onError: (err) => setError(err instanceof Error ? err.message : "Could not delete the conversation."),
    });
  }

  return (
    <section className={compact ? "w-full" : "flex h-full w-full flex-col"}>
      <div className="flex items-center justify-between gap-2 px-1 pb-3">
        <h2 className="text-xs font-bold uppercase tracking-[0.13em] text-muted">Recent conversations</h2>
        <button aria-label="Refresh conversations" onClick={() => void sessions.refetch()} className="rounded-lg p-1.5 text-muted hover:bg-[#f1f4ef]"><RefreshCw size={14} /></button>
      </div>
      <Button variant="secondary" className="mb-3 w-full justify-start" onClick={startNew} disabled={create.isPending}><MessageSquarePlus size={16} />{create.isPending ? "Starting…" : "New conversation"}</Button>
      {error && <div className="mb-3"><Notice>{error}</Notice></div>}
      <div className={compact ? "grid gap-1 sm:grid-cols-2" : "min-h-0 flex-1 space-y-1 overflow-y-auto"}>
        {sessions.isPending && <p className="px-3 py-4 text-xs text-muted">Loading conversations…</p>}
        {sessions.isError && <p className="px-3 py-4 text-xs text-red-700">{sessions.error.message}</p>}
        {sessions.data?.map((session) => (
          <div key={session.id} className={"group rounded-xl px-2 py-2 transition " + (session.id === activeId ? "bg-mint" : "hover:bg-[#f3f5f1]")}>
            {renaming === session.id ? (
              <form onSubmit={(event) => saveTitle(event, session.id)} className="flex items-center gap-1">
                <Input aria-label="Conversation title" autoFocus maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} className="px-2 py-2 text-xs" />
                <button aria-label="Save title" className="rounded-md p-1.5 text-moss"><Check size={14} /></button>
                <button type="button" aria-label="Cancel rename" onClick={() => setRenaming("")} className="rounded-md p-1.5 text-muted"><X size={14} /></button>
              </form>
            ) : (
              <div className="flex min-w-0 items-center gap-1">
                <Link href={"/chat/" + session.id} className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{session.title}</span>
                  <span className="mt-0.5 block text-[10px] text-muted">{shortDate(session.updatedAt)}</span>
                </Link>
                <button aria-label={"Rename " + session.title} onClick={() => { setRenaming(session.id); setTitle(session.title); setError(""); }} className="rounded-md p-1.5 text-muted opacity-0 transition hover:bg-white hover:text-ink group-hover:opacity-100 focus:opacity-100"><Pencil size={13} /></button>
                <button aria-label={"Delete " + session.title} onClick={() => deleteSession(session.id, session.title)} disabled={remove.isPending} className="rounded-md p-1.5 text-muted opacity-0 transition hover:bg-red-50 hover:text-red-700 group-hover:opacity-100 focus:opacity-100"><Trash2 size={13} /></button>
              </div>
            )}
          </div>
        ))}
        {!sessions.isPending && !sessions.data?.length && <p className="px-3 py-4 text-xs leading-5 text-muted">Your conversations will appear here.</p>}
      </div>
    </section>
  );
}
