import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MemoryOptions {
  /** Keep at most this many of the most recent messages verbatim. */
  maxMessages?: number;
  /** Start condensing once the transcript exceeds this many characters. */
  maxChars?: number;
  /** Messages kept verbatim when condensing. */
  keepRecent?: number;
}

export interface PreparedHistory {
  messages: HistoryMessage[];
  /** Condensed description of the dropped older messages, if summarization succeeded. */
  summary?: string;
  /** True when older messages were dropped (summarized or not). */
  trimmed: boolean;
  summarizationFailed?: boolean;
}

const totalChars = (m: HistoryMessage[]) => m.reduce((n, x) => n + x.content.length, 0);

/**
 * Keeps the conversation inside the context window. Long histories are condensed with the model;
 * if summarization fails for ANY reason we silently fall back to plain trimming, so a flaky summarizer
 * can never break a chat turn.
 */
export async function prepareHistory(
  history: HistoryMessage[],
  options: MemoryOptions & { summarizer?: BaseChatModel; signal?: AbortSignal } = {},
): Promise<PreparedHistory> {
  const maxMessages = options.maxMessages ?? 30;
  const maxChars = options.maxChars ?? 24_000;
  const keepRecent = Math.min(options.keepRecent ?? 10, maxMessages);

  if (history.length <= maxMessages && totalChars(history) <= maxChars) return { messages: history, trimmed: false };

  let recent = history.slice(-keepRecent);
  // Never start with an assistant turn: providers expect the conversation to open with the user.
  while (recent.length > 0 && recent[0]!.role !== 'user') recent = recent.slice(1);
  // Drop oldest kept messages until we fit the character budget (but always keep the last message).
  while (recent.length > 1 && totalChars(recent) > maxChars) recent = recent.slice(1);
  const older = history.slice(0, history.length - recent.length);

  if (!options.summarizer || older.length === 0) return { messages: recent, trimmed: true };

  try {
    const transcript = older.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n').slice(-16_000);
    const res = await options.summarizer.invoke(
      [
        ['system', 'Summarize the earlier part of this conversation in under 200 words. Keep names, decisions, facts and open questions. Output only the summary.'],
        ['human', transcript],
      ],
      { signal: options.signal },
    );
    const summary = typeof res.content === 'string' ? res.content.trim() : '';
    return summary ? { messages: recent, summary, trimmed: true } : { messages: recent, trimmed: true, summarizationFailed: true };
  } catch {
    return { messages: recent, trimmed: true, summarizationFailed: true };
  }
}
