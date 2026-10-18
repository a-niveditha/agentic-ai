import { describe, expect, it } from 'bun:test';
import { CircuitOpenError, classifyError, friendlyMessage } from '../errors.js';

describe('classifyError', () => {
  const cases: [string, unknown, string, boolean, boolean][] = [
    // [label, error, kind, retryable, serviceFailure]
    ['429 status', Object.assign(new Error('x'), { status: 429 }), 'rate_limit', true, true],
    ['RESOURCE_EXHAUSTED text', new Error('RESOURCE_EXHAUSTED: quota'), 'rate_limit', true, true],
    ['status in message', new Error('[GoogleGenerativeAI Error]: [429 Too Many Requests]'), 'rate_limit', true, true],
    ['401', Object.assign(new Error('nope'), { status: 401 }), 'auth', false, true],
    ['api key text', new Error('API key not valid. Please pass a valid API key.'), 'auth', false, true],
    ['400 bad request', Object.assign(new Error('bad'), { status: 400 }), 'bad_request', false, false],
    ['404', Object.assign(new Error('gone'), { response: { status: 404 } }), 'bad_request', false, false],
    ['503', Object.assign(new Error('down'), { status: 503 }), 'unavailable', true, true],
    ['timeout name', Object.assign(new Error('slow'), { name: 'TimeoutError' }), 'timeout', true, true],
    ['ETIMEDOUT', new Error('connect ETIMEDOUT 1.2.3.4:443'), 'timeout', true, true],
    ['ECONNREFUSED', new Error('connect ECONNREFUSED 127.0.0.1:8000'), 'network', true, true],
    ['fetch failed', new TypeError('fetch failed'), 'network', true, true],
    ['abort', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'aborted', false, false],
    ['unknown', new Error('weird'), 'unknown', false, false],
  ];
  for (const [label, err, kind, retryable, serviceFailure] of cases) {
    it(`classifies ${label}`, () => {
      const c = classifyError(err);
      expect(c.kind).toBe(kind as any);
      expect(c.retryable).toBe(retryable);
      expect(c.serviceFailure).toBe(serviceFailure);
    });
  }

  it('reads Retry-After seconds from headers', () => {
    const err = Object.assign(new Error('slow down'), { status: 429, response: { headers: { 'retry-after': '3' } } });
    expect(classifyError(err).retryAfterMs).toBe(3000);
  });

  it('reads Retry-After from a Headers object', () => {
    const err = Object.assign(new Error('slow down'), { status: 429, response: { headers: new Headers({ 'retry-after': '2' }) } });
    expect(classifyError(err).retryAfterMs).toBe(2000);
  });

  it('classifies CircuitOpenError as non-retryable and not a service failure', () => {
    const c = classifyError(new CircuitOpenError('svc', 1500));
    expect(c).toMatchObject({ kind: 'circuit_open', retryable: false, serviceFailure: false, retryAfterMs: 1500 });
  });

  it('handles non-Error throwables', () => {
    expect(classifyError('ECONNRESET happened').kind).toBe('network');
    expect(classifyError(undefined).kind).toBe('unknown');
  });
});

describe('friendlyMessage', () => {
  it('never leaks provider details and names the component', () => {
    for (const kind of ['rate_limit', 'timeout', 'network', 'unavailable', 'circuit_open', 'auth', 'aborted', 'bad_request', 'unknown'] as const) {
      const msg = friendlyMessage(kind, 'The AI model');
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toMatch(/stack|at \w+\.|key=|AIza/i);
    }
    expect(friendlyMessage('rate_limit', 'The AI model')).toContain('The AI model');
  });
});
