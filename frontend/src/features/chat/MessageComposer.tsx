"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button, Textarea } from "@/components/ui";

export function MessageComposer({ busy, onSend, onCancel, error }: {
  busy: boolean;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
  error?: string;
}) {
  const [value, setValue] = useState("");
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    await onSend(text);
    setValue("");
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }
  return (
    <div className="border-t border-line bg-white px-4 py-4 sm:px-8">
      {error && <p role="alert" className="mx-auto mb-2 max-w-[900px] text-sm text-red-700">{error}</p>}
      <form onSubmit={submit} className="mx-auto max-w-[900px] rounded-2xl border border-line bg-[#fbfcfa] p-2 shadow-sm focus-within:border-[#b9d2c1]">
        <Textarea aria-label="Message" rows={2} maxLength={4000} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={keyDown} disabled={busy} placeholder="Message Fieldnote…" className="min-h-[64px] border-0 bg-transparent px-3 py-2 focus:border-0 focus:ring-0" />
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[11px] text-muted">Enter to send · Shift + Enter for a new line</span>
          {busy ? <Button type="button" variant="secondary" className="px-3 py-2" onClick={onCancel}><Square size={13} />Stop</Button> : <Button type="submit" className="px-3 py-2" disabled={!value.trim()}><ArrowUp size={16} />Send</Button>}
        </div>
      </form>
      <p className="mx-auto mt-2 max-w-[900px] text-center text-[10px] text-[#99a29b]">AI responses can make mistakes. Check important details against the sources.</p>
    </div>
  );
}
