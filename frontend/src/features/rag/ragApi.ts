import { streamRequest } from "@/lib/apiClient";
import { readSse, type StreamEvent } from "@/lib/readSse";

export async function runRagQuery(
  question: string,
  topK: number,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await streamRequest("/rag/query", { question, topK }, signal);
  await readSse(response, onEvent);
}
