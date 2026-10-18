import { Check, Circle, LoaderCircle, Wrench, X } from "lucide-react";
import type { LiveTool, ToolRecord } from "./chatTypes";

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function ToolActivity({ tools, live }: { tools: Array<LiveTool | ToolRecord>; live?: boolean }) {
  if (!tools.length) return null;
  return (
    <details className="mt-3 rounded-xl border border-line bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium text-muted">
        <Wrench size={14} />Used {tools.length} {tools.length === 1 ? "tool" : "tools"}
        {live && <span className="ml-auto flex items-center gap-1 text-moss"><LoaderCircle size={12} className="animate-spin" />Working</span>}
      </summary>
      <div className="space-y-2 border-t border-line p-3">
        {tools.map((tool, index) => {
          const name = "tool" in tool ? tool.tool : tool.name;
          const result = "output" in tool ? tool.output : undefined;
          const success = (tool as LiveTool).success ?? (tool as ToolRecord).ok;
          return (
            <div key={("id" in tool ? tool.id : name) + index} className="rounded-lg bg-[#f7f8f5] p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-ink">
                {success === undefined ? <Circle size={12} className="text-muted" /> : success ? <Check size={13} className="text-moss" /> : <X size={13} className="text-red-600" />}
                {name}
              </div>
              {"input" in tool && tool.input !== undefined && <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-5 text-muted">Input: {display(tool.input)}</pre>}
              {result !== undefined && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-muted">Output: {display(result)}</pre>}
            </div>
          );
        })}
      </div>
    </details>
  );
}
