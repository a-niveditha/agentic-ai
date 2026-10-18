import { CircuitOpenError, classifyError } from './errors.js';
import { HealthCheckable, HealthReport, healthReport } from './health.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive service failures before the circuit opens. */
  failureThreshold?: number;
  /** How long the circuit stays open before letting one probe call through. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Decide whether an error counts against the service. Defaults to classifyError().serviceFailure. */
  isServiceFailure?: (err: unknown) => boolean;
}

export class CircuitBreaker implements HealthCheckable {
  readonly componentName: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly isServiceFailure: (err: unknown) => boolean;

  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private lastError?: string;

  constructor(opts: CircuitBreakerOptions) {
    this.componentName = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.isServiceFailure = opts.isServiceFailure ?? ((e) => classifyError(e).serviceFailure);
  }

  get state(): CircuitState {
    if (this.failures < this.failureThreshold) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  /** Throws CircuitOpenError when calls should not be attempted. */
  assertAvailable(): void {
    const state = this.state;
    if (state === 'open') {
      throw new CircuitOpenError(this.componentName, this.cooldownMs - (this.now() - this.openedAt));
    }
    if (state === 'half-open') {
      if (this.probing) throw new CircuitOpenError(this.componentName, this.cooldownMs);
      this.probing = true;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.probing = false;
    this.lastError = undefined;
  }

  recordFailure(err: unknown): void {
    this.probing = false;
    if (!this.isServiceFailure(err)) return;
    this.failures += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.failures >= this.failureThreshold) this.openedAt = this.now();
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  reset(): void {
    this.failures = 0;
    this.probing = false;
    this.lastError = undefined;
  }

  async checkHealth(): Promise<HealthReport> {
    switch (this.state) {
      case 'closed':
        return healthReport(this.failures > 0 ? 'degraded' : 'up', this.lastError);
      case 'half-open':
        return healthReport('degraded', `recovering: ${this.lastError ?? 'probing'}`);
      default:
        return healthReport('down', `circuit open: ${this.lastError ?? 'repeated failures'}`);
    }
  }
}
