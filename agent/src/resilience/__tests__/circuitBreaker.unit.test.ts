import { describe, expect, it } from 'bun:test';
import { CircuitBreaker } from '../circuitBreaker.js';
import { CircuitOpenError } from '../errors.js';

const boom = Object.assign(new Error('down'), { status: 503 });
const badInput = Object.assign(new Error('bad'), { status: 400 });

function make(threshold = 3, cooldownMs = 1000) {
  let t = 0;
  const breaker = new CircuitBreaker({ name: 'svc', failureThreshold: threshold, cooldownMs, now: () => t });
  return { breaker, advance: (ms: number) => (t += ms) };
}

describe('CircuitBreaker', () => {
  it('starts closed and passes calls through', async () => {
    const { breaker } = make();
    expect(breaker.state).toBe('closed');
    expect(await breaker.execute(async () => 42)).toBe(42);
    expect((await breaker.checkHealth()).status).toBe('up');
  });

  it('opens after N consecutive service failures and then fails fast without calling', async () => {
    const { breaker } = make(3);
    let calls = 0;
    const failing = async () => { calls++; throw boom; };
    for (let i = 0; i < 3; i++) await expect(breaker.execute(failing)).rejects.toBe(boom);
    expect(breaker.state).toBe('open');
    await expect(breaker.execute(failing)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(3);
    expect((await breaker.checkHealth()).status).toBe('down');
  });

  it('does not count client errors (4xx) as service failures', async () => {
    const { breaker } = make(2);
    for (let i = 0; i < 5; i++) await expect(breaker.execute(async () => { throw badInput; })).rejects.toBe(badInput);
    expect(breaker.state).toBe('closed');
  });

  it('a success resets the failure count', async () => {
    const { breaker } = make(3);
    for (let i = 0; i < 2; i++) await breaker.execute(async () => { throw boom; }).catch(() => {});
    expect((await breaker.checkHealth()).status).toBe('degraded');
    await breaker.execute(async () => 'ok');
    for (let i = 0; i < 2; i++) await breaker.execute(async () => { throw boom; }).catch(() => {});
    expect(breaker.state).toBe('closed');
  });

  it('goes half-open after the cooldown, lets exactly one probe through, and closes on success', async () => {
    const { breaker, advance } = make(2, 1000);
    for (let i = 0; i < 2; i++) await breaker.execute(async () => { throw boom; }).catch(() => {});
    expect(breaker.state).toBe('open');
    advance(1001);
    expect(breaker.state).toBe('half-open');
    expect((await breaker.checkHealth()).status).toBe('degraded');

    let release!: () => void;
    const probe = breaker.execute(() => new Promise<string>((r) => { release = () => r('recovered'); }));
    await expect(breaker.execute(async () => 'second')).rejects.toBeInstanceOf(CircuitOpenError); // only one probe
    release();
    expect(await probe).toBe('recovered');
    expect(breaker.state).toBe('closed');
  });

  it('re-opens when the half-open probe fails', async () => {
    const { breaker, advance } = make(2, 1000);
    for (let i = 0; i < 2; i++) await breaker.execute(async () => { throw boom; }).catch(() => {});
    advance(1001);
    await expect(breaker.execute(async () => { throw boom; })).rejects.toBe(boom);
    expect(breaker.state).toBe('open');
    await expect(breaker.execute(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('exposes retry hint on CircuitOpenError', async () => {
    const { breaker, advance } = make(1, 1000);
    await breaker.execute(async () => { throw boom; }).catch(() => {});
    advance(400);
    const err = await breaker.execute(async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.retryAfterMs).toBe(600);
  });

  it('reset() closes the circuit', async () => {
    const { breaker } = make(1);
    await breaker.execute(async () => { throw boom; }).catch(() => {});
    expect(breaker.state).toBe('open');
    breaker.reset();
    expect(breaker.state).toBe('closed');
  });
});
