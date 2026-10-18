import { describe, expect, it } from 'bun:test';
import { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import { CircuitOpenError } from '../../resilience/errors.js';
import { GeminiChatModelProvider } from '../GeminiChatModelProvider.js';

describe('GeminiChatModelProvider credential health', () => {
  it('a rejected key marks the provider down immediately; a later success clears it', async () => {
    const p = new GeminiChatModelProvider({ apiKey: 'k' });
    const model: any = p.createChatModel();
    const handler = model.callbacks.find((h: any) => h.name === 'circuit-breaker-handler');
    expect((await p.checkHealth()).status).toBe('up');
    handler.handleLLMError(Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 }));
    const h = await p.checkHealth();
    expect(h.status).toBe('down');
    expect(h.detail).toMatch(/rejected/);
    handler.handleLLMEnd();
    expect((await p.checkHealth()).status).toBe('up');
  });

  it('transient errors only degrade; they do not claim the key is bad', async () => {
    const p = new GeminiChatModelProvider({ apiKey: 'k' });
    const handler = (p.createChatModel() as any).callbacks.find((h: any) => h.name === 'circuit-breaker-handler');
    handler.handleLLMError(Object.assign(new Error('unavailable'), { status: 503 }));
    expect((await p.checkHealth()).status).toBe('degraded');
  });

  it('passes extra callbacks to the model', () => {
    const extra = { name: 'extra' } as any;
    const model: any = new GeminiChatModelProvider({ apiKey: 'k', callbacks: [extra] }).createChatModel();
    expect(model.callbacks).toContain(extra);
  });
});

describe('GeminiChatModelProvider', () => {
  it('reads model from config and exposes identity', () => {
    const p = new GeminiChatModelProvider({ apiKey: 'k', model: 'gemini-test' });
    expect(p.modelId).toBe('gemini-test');
    expect(p.name).toBe('google-genai');
    expect(p.componentName).toBe('llm:gemini');
  });

  it('creates a chat model when a key is configured', () => {
    const model = new GeminiChatModelProvider({ apiKey: 'k' }).createChatModel({ temperature: 0 });
    expect(typeof (model as any).invoke).toBe('function');
  });

  it('without a key: assertAvailable and createChatModel throw a clear error, health is down', async () => {
    const saved = { g: process.env.GEMINI_API_KEY, k: process.env.GOOGLE_API_KEY };
    delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
    try {
      const p = new GeminiChatModelProvider({});
      expect(() => p.assertAvailable()).toThrow(/API key/);
      expect(() => p.createChatModel()).toThrow(/API key/);
      const h = await p.checkHealth();
      expect(h.status).toBe('down');
      expect(h.detail).toContain('GEMINI_API_KEY');
    } finally {
      if (saved.g) process.env.GEMINI_API_KEY = saved.g;
      if (saved.k) process.env.GOOGLE_API_KEY = saved.k;
    }
  });

  it('assertAvailable fails fast once the breaker is open, and health reflects it', async () => {
    const breaker = new CircuitBreaker({ name: 'llm', failureThreshold: 2, cooldownMs: 60_000 });
    const p = new GeminiChatModelProvider({ apiKey: 'k', breaker });
    expect(() => p.assertAvailable()).not.toThrow();
    const boom = Object.assign(new Error('down'), { status: 503 });
    breaker.recordFailure(boom);
    breaker.recordFailure(boom);
    expect(() => p.assertAvailable()).toThrow(CircuitOpenError);
    expect((await p.checkHealth()).status).toBe('down');
  });

  it('assertAvailable does not consume the half-open probe slot', () => {
    let t = 0;
    const breaker = new CircuitBreaker({ name: 'llm', failureThreshold: 1, cooldownMs: 100, now: () => t });
    const p = new GeminiChatModelProvider({ apiKey: 'k', breaker });
    breaker.recordFailure(Object.assign(new Error('x'), { status: 503 }));
    t = 200;
    expect(() => p.assertAvailable()).not.toThrow();
    expect(() => p.assertAvailable()).not.toThrow();
    expect(breaker.state).toBe('half-open');
  });
});
