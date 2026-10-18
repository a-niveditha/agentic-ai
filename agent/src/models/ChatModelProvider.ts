import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { HealthCheckable } from '../resilience/health.js';

export interface ChatModelOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Extension point for LLM vendors. Implement this (see GeminiChatModelProvider) and pass the instance to
 * the agent / RAG chain. A provider owns its credentials, retry policy and circuit breaker.
 */
export interface ChatModelProvider extends HealthCheckable {
  readonly name: string;
  readonly modelId: string;
  /** Throws CircuitOpenError when the vendor is known to be down, so callers can fail fast. */
  assertAvailable(): void;
  createChatModel(options?: ChatModelOptions): BaseChatModel;
}
