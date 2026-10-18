import type { Citation } from "../shared/CitationList";
export type { Citation } from "../shared/CitationList";

export type ToolRecord = { name: string; input?: unknown; ok?: boolean };
export type MessageMetadata = {
  status?: "completed" | "interrupted" | "limit_reached" | "error";
  citations?: Citation[];
  toolCalls?: ToolRecord[];
  error?: { message?: string } | string;
};

export type ChatMessage = {
  id: string;
  sessionId: string;
  sender: "user" | "agent";
  content: string;
  createdAt: string;
  metadata: MessageMetadata | null;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type LiveTool = {
  id: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  success?: boolean;
};

export type TurnDraft = {
  content: string;
  citations: Citation[];
  tools: LiveTool[];
  status?: string;
  error?: string;
};
