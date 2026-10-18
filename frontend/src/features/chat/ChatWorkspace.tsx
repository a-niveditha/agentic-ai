"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, LoaderCircle } from "lucide-react";
import { Button, Notice } from "@/components/ui";
import { getSessions, chatKeys } from "./chatApi";
import { useMessages } from "./chatQueries";
import { useChatStream } from "./useChatStream";
import { ConversationList } from "./ConversationList";
import { MessageComposer } from "./MessageComposer";
import { MessageList } from "./MessageList";

export function ChatWorkspace({ sessionId }: { sessionId?: string }) {
  const sessions = useQuery({ queryKey: chatKeys.sessions, queryFn: getSessions });
  const messages = useMessages(sessionId || "");
  const stream = useChatStream(sessionId || "");
  const current = sessions.data?.find((session) => session.id === sessionId);

  return (
    <section className="flex min-h-[72vh] flex-col overflow-hidden rounded-[26px] border border-line bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-line px-5 py-4 sm:px-7">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-moss">Conversations</p>
          <h1 className="mt-1 truncate text-lg font-semibold tracking-tight text-ink">{current?.title || (sessionId ? "Conversation" : "A clear space to start")}</h1>
        </div>
        {stream.busy && <span className="flex items-center gap-2 text-xs text-muted"><LoaderCircle size={14} className="animate-spin text-moss" />Thinking</span>}
      </header>
      <details className="border-b border-line px-4 py-3 md:hidden">
        <summary className="cursor-pointer text-sm font-medium text-moss">Conversation history</summary>
        <div className="pt-3"><ConversationList activeId={sessionId} compact /></div>
      </details>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[270px] shrink-0 border-r border-line p-4 md:block"><ConversationList activeId={sessionId} /></aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {!sessionId ? (
            <div className="grid flex-1 place-items-center p-8 text-center">
              <div className="max-w-md"><span className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-mint text-moss"><Bot size={27} /></span><h2 className="text-2xl font-semibold tracking-tight">What’s on your mind?</h2><p className="mt-3 text-sm leading-6 text-muted">Start a conversation to explore ideas, ask about your documents, or get help with a task.</p><p className="mt-5 text-xs text-muted">Choose “New conversation” to begin.</p></div>
            </div>
          ) : (
            <>
              {messages.isError && <div className="p-5"><Notice>{messages.error.message}</Notice><Button variant="secondary" className="mt-3" onClick={() => void messages.refetch()}>Reload conversation</Button></div>}
              {messages.isPending ? <div className="grid flex-1 place-items-center text-sm text-muted">Loading messages…</div> : <MessageList messages={messages.data || []} draft={stream.draft} busy={stream.busy} onSuggestion={(text) => void stream.send(text)} />}
              <MessageComposer busy={stream.busy} onSend={stream.send} onCancel={stream.cancel} error={stream.requestError} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
