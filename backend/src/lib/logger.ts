import pino, { type Logger } from 'pino';

export type { Logger };

const SENSITIVE_QUERY = /([?&](?:ticket|token|auth_token|key|api_key)=)[^&]*/gi;

export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(SENSITIVE_QUERY, '$1[REDACTED]');
}

export function createLogger(level: string, destination?: { write(chunk: string): void }): Logger {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', '*.password', '*.passwordHash', '*.apiKey', '*.token', '*.ticket'],
      censor: '[REDACTED]',
    },
  }, destination as any);
}
