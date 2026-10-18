import { BaseCallbackHandler, GeminiChatModelProvider } from '../../agent/src/index.js';

/**
 * The free Gemini tier allows ~10 chat requests/minute per model. Live tests share one pacer so the whole
 * suite stays under that limit instead of flaking on 429s.
 */
class Pacer extends BaseCallbackHandler {
  name = 'gemini-test-pacer';
  awaitHandlers = true;
  private next = 0;
  constructor(private readonly minGapMs: number) { super(); }
  override async handleLLMStart(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.next);
    this.next = start + this.minGapMs;
    if (start > now) await new Promise((r) => setTimeout(r, start - now));
  }
}

const pacer = new Pacer(Number(process.env.GEMINI_TEST_GAP_MS ?? 6500));

export const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

/**
 * Model used by live tests. Free-tier quotas are per model per day, so tests default to a model separate from
 * the one in the developer's .env (override with GEMINI_TEST_MODEL).
 */
export const TEST_MODEL = process.env.GEMINI_TEST_MODEL || 'gemini-3.5-flash-lite';

export function pacedGemini(overrides: ConstructorParameters<typeof GeminiChatModelProvider>[0] = {}) {
  return new GeminiChatModelProvider({ apiKey: geminiApiKey, model: TEST_MODEL, maxRetries: 6, ...overrides, callbacks: [pacer, ...(overrides.callbacks ?? [])] });
}
