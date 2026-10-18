import { BookOpen, ExternalLink } from "lucide-react";

export type Citation = {
  title: string;
  source: string;
  content: string;
  sourceId?: string;
  url?: string;
  page?: number;
  section?: string;
};

function safeLink(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function CitationList({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-muted"><BookOpen size={13} />Sources</p>
      <div className="flex flex-wrap gap-2">
        {citations.map((citation, index) => {
          const href = safeLink(citation.url || citation.source);
          return <a key={citation.sourceId + "-" + index} href={href || undefined} target={href ? "_blank" : undefined} rel={href ? "noreferrer" : undefined} className="group max-w-full rounded-lg border border-line bg-white px-3 py-2 text-left hover:border-[#bfd5c6]">
            <span className="flex items-center gap-1 text-xs font-medium text-ink">{citation.title || citation.source}{href && <ExternalLink size={11} className="shrink-0 text-muted" />}</span>
            <span className="mt-1 block truncate text-[11px] text-muted">{citation.page ? "Page " + citation.page : citation.section || citation.source}</span>
            {citation.content && <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[#59665e]">{citation.content}</span>}
          </a>;
        })}
      </div>
    </div>
  );
}
