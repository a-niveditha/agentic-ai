import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { classifyError } from '../resilience/errors.js';
import { HealthReport, healthReport } from '../resilience/health.js';
import type { ChatModelOptions, ChatModelProvider } from './ChatModelProvider.js';

export interface GeminiChatModelConfig {
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** LangChain-level retries per request (transient 429/5xx). */
  maxRetries?: number;
  breaker?: CircuitBreaker;
  /** Extra LangChain callback handlers (metrics, tracing, test pacing...). */
  callbacks?: BaseCallbackHandler[];
}

/** Feeds LLM outcomes into the circuit breaker (and credential state) so a dead vendor stops being called. */
class BreakerCallbackHandler extends BaseCallbackHandler {
  name = 'circuit-breaker-handler';
  constructor(private readonly breaker: CircuitBreaker, private readonly onAuth: (rejected: boolean) => void) {
    super();
  }
  override handleLLMEnd(): void {
    this.breaker.recordSuccess();
    this.onAuth(false);
  }
  override handleLLMError(err: unknown): void {
    this.breaker.recordFailure(err);
    if (classifyError(err).kind === 'auth') this.onAuth(true);
  }
}

export class GeminiChatModelProvider implements ChatModelProvider {
  readonly name = 'google-genai';
  readonly componentName = 'llm:gemini';
  readonly modelId: string;
  readonly breaker: CircuitBreaker;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly maxRetries: number;
  private readonly extraCallbacks: BaseCallbackHandler[];
  /** True after the vendor rejected our credentials: retrying cannot help, so health is `down` right away. */
  private credentialsRejected = false;

  constructor(config: GeminiChatModelConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
    this.modelId = config.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    this.temperature = config.temperature ?? 0.2;
    this.maxRetries = config.maxRetries ?? 2;
    this.extraCallbacks = config.callbacks ?? [];
    this.breaker = config.breaker ?? new CircuitBreaker({ name: this.componentName, failureThreshold: 4, cooldownMs: 20_000 });
  }

  assertAvailable(): void {
    if (!this.apiKey) throw new Error('Gemini API key is not configured (set GEMINI_API_KEY).');
    // Peek without consuming a half-open probe slot: the breaker records the real outcome via callbacks.
    if (this.breaker.state === 'open') this.breaker.assertAvailable();
  }

  createChatModel(options: ChatModelOptions = {}): BaseChatModel {
    if (!this.apiKey) throw new Error('Gemini API key is not configured (set GEMINI_API_KEY).');
    return new ChatGoogleGenerativeAI({
      apiKey: this.apiKey,
      model: this.modelId,
      temperature: options.temperature ?? this.temperature,
      maxOutputTokens: options.maxOutputTokens,
      maxRetries: this.maxRetries,
      streaming: true,
      callbacks: [new BreakerCallbackHandler(this.breaker, (rejected) => (this.credentialsRejected = rejected)), ...this.extraCallbacks],
    }) as unknown as BaseChatModel;
  }

  /** No network call: key presence + breaker state, so /ready never burns quota. */
  async checkHealth(): Promise<HealthReport> {
    if (!this.apiKey) return healthReport('down', 'GEMINI_API_KEY is not configured');
    if (this.credentialsRejected) return healthReport('down', 'the API key was rejected by Google');
    return this.breaker.checkHealth();
  }
}
