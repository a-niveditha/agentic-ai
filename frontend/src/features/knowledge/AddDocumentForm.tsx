"use client";

import { useRef, useState, type FormEvent } from "react";
import { FileUp, Link2, LoaderCircle, Type } from "lucide-react";
import { ApiError } from "@/lib/apiClient";
import { Button, Field, Input, Notice, Textarea, cx } from "@/components/ui";
import { useAddDocument } from "./knowledgeApi";

type Mode = "file" | "text" | "url";

export function AddDocumentForm({ extensions }: { extensions: string[] }) {
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState<{ text: string; tone: "error" | "info" | "success" } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const add = useAddDocument();
  const tabs = [
    { id: "file" as const, label: "Upload file", icon: FileUp },
    { id: "text" as const, label: "Paste text", icon: Type },
    { id: "url" as const, label: "Add a link", icon: Link2 },
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    if (mode === "file" && file) {
      const body = new FormData();
      body.append("file", file);
      await send(body);
    } else if (mode === "text" && text.trim()) {
      await send({ title: title.trim() || "Pasted text", text: text.trim() });
    } else if (mode === "url" && url.trim()) {
      await send({ url: url.trim() });
    }
  }

  async function send(body: FormData | { text: string; title: string } | { url: string }) {
    try {
      const result = await add.mutateAsync(body);
      setNotice({ text: "Added “" + result.document.filename + "”. Indexing is running in the background.", tone: "success" });
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setText("");
      setTitle("");
      setUrl("");
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.code === "duplicate_document") {
        setNotice({ text: "This content is already in your knowledge base. Remove the existing copy before adding it again.", tone: "info" });
      } else if (apiError.code === "queue_full") {
        setNotice({ text: "The indexing queue is full. Wait a moment and try again.", tone: "info" });
      } else {
        setNotice({ text: error instanceof Error ? error.message : "Could not add this document.", tone: "error" });
      }
    }
  }

  const accept = extensions.map((extension) => "." + extension).join(",");
  const disabled = add.isPending;
  return (
    <section className="rounded-[24px] border border-line bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-5"><p className="text-xs font-bold uppercase tracking-[0.14em] text-moss">Add to your library</p><h2 className="mt-1 text-xl font-semibold tracking-tight">Bring your knowledge in</h2><p className="mt-1 text-sm text-muted">Upload a file, paste notes, or index a public webpage.</p></div>
      <div role="tablist" aria-label="Document source" className="mb-5 flex gap-1 rounded-xl bg-[#f4f6f2] p-1">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={mode === id} onClick={() => { setMode(id); setNotice(null); }} className={cx("flex flex-1 items-center justify-center gap-2 rounded-lg px-2 py-2.5 text-xs font-medium transition", mode === id ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink")}><Icon size={14} />{label}</button>)}
      </div>
      <form onSubmit={submit} className="space-y-4">
        {mode === "file" && <Field label="Choose a file" hint={extensions.length ? "Accepted: " + extensions.map((item) => "." + item).join(", ") : "The server will validate the file type."}><Input ref={fileInput} type="file" accept={accept} onChange={(event) => setFile(event.target.files?.[0] || null)} required className="file:mr-3 file:rounded-lg file:border-0 file:bg-mint file:px-3 file:py-2 file:text-xs file:font-semibold file:text-moss" /></Field>}
        {mode === "text" && <><Field label="Title"><Input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Project notes" /></Field><Field label="Text to index"><Textarea required maxLength={1500000} rows={7} value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste the text you want to search later…" /></Field></>}
        {mode === "url" && <Field label="Public webpage URL" hint="The server blocks private and local network addresses."><Input type="url" required maxLength={2000} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/guide" /></Field>}
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        <Button type="submit" disabled={disabled || (mode === "file" && !file)} className="w-full">{disabled && <LoaderCircle size={15} className="animate-spin" />}{disabled ? "Sending…" : "Add document"}</Button>
      </form>
    </section>
  );
}
