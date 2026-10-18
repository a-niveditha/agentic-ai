"use client";

import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, UserRound } from "lucide-react";
import { CitationList } from "../shared/CitationList";
import { ToolActivity } from "./ToolActivity";
import type { ChatMessage, TurnDraft } from "./chatTypes";

const markdownPlugins = [remarkGfm];

function ReplyBody({ content }: { content: string }) {
  return <div className="markdown-content text-[14px] text-ink"><ReactMarkdown remarkPlugins={markdownPlugins}>{content || "Thinking…"}</ReactMarkdown></div>;
}

export function MessageList({ messages, draft, busy, onSuggestion }: {
  messages: ChatMessage[];
  draft: TurnDraft | null;
  busy: boolean;
  onSuggestion: (text: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, draft]);

  if (!messages.length && !draft) {
    return (
      <div className="grid min-h-[420px] flex-1 place-items-center px-5 py-10 text-center">
        <div className="max-w-lg">
          <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-mint text-moss"><Bot size={26} /></div>
          <h2 className="text-2xl font-semibold tracking-tight text-ink">What would you like to work through?</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted">Ask a question, explore an idea, or find an answer in your knowledge base.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {["Summarize the key ideas", "What do my documents say?", "Help me plan a project"].map((idea) => <button key={idea} onClick={() => onSuggestion(idea)} className="rounded-full border border-line bg-white px-3.5 py-2 text-xs text-[#56645b] transition hover:border-[#b9d2c1] hover:text-moss">{idea}</button>)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-7 overflow-y-auto px-4 py-6 sm:px-8">
      {messages.map((message) => (
        <article key={message.id} className={message.sender === "user" ? "ml-auto max-w-[820px]" : "max-w-[900px]"}>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted">
            <span className={message.sender === "user" ? "grid h-7 w-7 place-items-center rounded-full bg-[#e8ede8] text-[#536158]" : "grid h-7 w-7 place-items-center rounded-full bg-mint text-moss"}>{message.sender === "user" ? <UserRound size={14} /> : <Bot size={15} />}</span>
            {message.sender === "user" ? "You" : "Fieldnote"}
            {message.metadata?.status && message.metadata.status !== "completed" && <span className="rounded-full bg-[#f1f3ef] px-2 py-0.5 font-normal capitalize">{message.metadata.status.replace("_", " ")}</span>}
          </div>
          <div className={message.sender === "user" ? "rounded-2xl rounded-tr-sm bg-[#eaf0e9] px-4 py-3 sm:px-5" : "pl-9"}>
            {message.sender === "user" ? <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{message.content}</p> : <ReplyBody content={message.content} />}
            {message.sender === "agent" && message.metadata?.error && <p className="mt-3 text-sm text-red-700">{typeof message.metadata.error === "string" ? message.metadata.error : message.metadata.error.message}</p>}
            {message.sender === "agent" && message.metadata?.toolCalls && <ToolActivity tools={message.metadata.toolCalls} />}
            {message.sender === "agent" && message.metadata?.citations && <CitationList citations={message.metadata.citations} />}
          </div>
        </article>
      ))}
      {draft && <article className="max-w-[900px]"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted"><span className="grid h-7 w-7 place-items-center rounded-full bg-mint text-moss"><Bot size={15} /></span>Fieldnote <span className="font-normal">{busy ? "is thinking" : draft.status}</span></div><div className="pl-9"><ReplyBody content={draft.content} /><ToolActivity tools={draft.tools} live={busy} /><CitationList citations={draft.citations} />{draft.error && <p className="mt-3 text-sm text-red-700">{draft.error}</p>}</div></article>}
      <div ref={end} />
    </div>
  );
}
