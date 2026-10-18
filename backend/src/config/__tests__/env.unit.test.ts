import { describe, expect, it } from 'bun:test';
import { ConfigError, KNOWN_WEAK_JWT_SECRETS, loadConfig } from '../env.js';

const base = { JWT_SECRET: 'a-sufficiently-long-random-secret-value' };

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ PORT: 5000, NODE_ENV: 'development', VECTOR_STORE: 'chroma', EMBEDDING_PROVIDER: 'gemini', GEMINI_MODEL: 'gemini-2.5-flash', MAX_UPLOAD_MB: 10 });
    expect(c.corsOrigins).toEqual(['http://localhost:3000']);
    expect(c.defaultScopes).toEqual(['kb:read', 'kb:write', 'web']);
    expect(c.docsEnabled).toBe(true);
  });

  it('REQUIRES a JWT secret (no hard-coded fallback)', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/at least 16/);
  });

  it('refuses publicly known example secrets in production, warns elsewhere', () => {
    for (const weak of KNOWN_WEAK_JWT_SECRETS) {
      const secret = weak.length < 16 ? weak.padEnd(16, '!') : weak;
      if (secret !== weak) continue; // only the long known value passes the length check
      expect(() => loadConfig({ JWT_SECRET: weak, NODE_ENV: 'production' })).toThrow(/publicly known/);
      expect(loadConfig({ JWT_SECRET: weak }).warnings.join(' ')).toMatch(/publicly known/);
    }
  });

  it('collects the Gemini key from either variable and warns when absent', () => {
    expect(loadConfig({ ...base, GEMINI_API_KEY: 'k1' }).geminiApiKey).toBe('k1');
    expect(loadConfig({ ...base, GOOGLE_API_KEY: 'k2' }).geminiApiKey).toBe('k2');
    const none = loadConfig(base);
    expect(none.geminiApiKey).toBeUndefined();
    expect(none.warnings.join(' ')).toMatch(/degraded/);
  });

  it('parses lists, numbers and enums', () => {
    const c = loadConfig({ ...base, PORT: '8080', CORS_ORIGINS: 'https://a.test, https://b.test ,', DEFAULT_USER_SCOPES: 'kb:read,mcp', VECTOR_STORE: 'memory', MAX_UPLOAD_MB: '2.5' });
    expect(c.PORT).toBe(8080);
    expect(c.corsOrigins).toEqual(['https://a.test', 'https://b.test']);
    expect(c.defaultScopes).toEqual(['kb:read', 'mcp']);
    expect(c.VECTOR_STORE).toBe('memory');
    expect(c.MAX_UPLOAD_MB).toBe(2.5);
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, VECTOR_STORE: 'redis' })).toThrow(/VECTOR_STORE/);
    expect(() => loadConfig({ ...base, MAX_UPLOAD_MB: '-1' })).toThrow(/MAX_UPLOAD_MB/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it("forbids CORS '*' in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(/CORS/);
    expect(loadConfig({ ...base, CORS_ORIGINS: '*' }).corsOrigins).toEqual(['*']);
  });

  it('docs are off by default in production and can be toggled', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).docsEnabled).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'production', ENABLE_DOCS: 'true' }).docsEnabled).toBe(true);
    expect(loadConfig({ ...base, ENABLE_DOCS: 'false' }).docsEnabled).toBe(false);
  });
});
