import { apiRequest, streamRequest } from "@/lib/apiClient";
import { readSse, type StreamEvent } from "@/lib/readSse";
import type { ChatMessage, ChatSession } from "./chatTypes";

export const chatKeys = {
  sessions: ["chat", "sessions"] as const,
  messages: (id: string) => ["chat", "messages", id] as const,
};

export async function getSessions(): Promise<ChatSession[]> {
  return (await apiRequest<{ sessions: ChatSession[] }>("/chat/sessions")).sessions;
}

export async function createSession(): Promise<ChatSession> {
  return (await apiRequest<{ session: ChatSession }>("/chat/sessions", {
    method: "POST",
    body: JSON.stringify({}),
  })).session;
}

export function renameSession(id: string, title: string): Promise<{ success: boolean }> {
  return apiRequest("/chat/sessions/" + id, { method: "PATCH", body: JSON.stringify({ title }) });
}

export function deleteSession(id: string): Promise<{ success: boolean }> {
  return apiRequest("/chat/sessions/" + id, { method: "DELETE" });
}

export async function getMessages(id: string): Promise<ChatMessage[]> {
  return (await apiRequest<{ messages: ChatMessage[] }>("/chat/sessions/" + id + "/messages")).messages;
}

export async function streamMessage(
  id: string,
  text: string,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await streamRequest("/chat/sessions/" + id + "/messages", { text }, signal);
  await readSse(response, onEvent);
}
