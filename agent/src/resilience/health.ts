export type HealthStatus = 'up' | 'degraded' | 'down';

export interface HealthReport {
  status: HealthStatus;
  detail?: string;
  checkedAt: number;
}

/** Implemented by every component that talks to something that can fail. */
export interface HealthCheckable {
  readonly componentName: string;
  checkHealth(): Promise<HealthReport>;
}

export function healthReport(status: HealthStatus, detail?: string): HealthReport {
  return { status, detail, checkedAt: Date.now() };
}

/** Worst status wins: any `down` -> `down`, otherwise any `degraded` -> `degraded`. */
export function aggregateHealth(reports: Record<string, HealthReport>): HealthStatus {
  const statuses = Object.values(reports).map((r) => r.status);
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'up';
}

/** Runs checkHealth on every component; a throwing check is reported as `down`, never propagated. */
export async function collectHealth(
  components: HealthCheckable[],
): Promise<Record<string, HealthReport>> {
  const entries = await Promise.all(
    components.map(async (c): Promise<[string, HealthReport]> => {
      try {
        return [c.componentName, await c.checkHealth()];
      } catch (err) {
        return [c.componentName, healthReport('down', errorMessage(err))];
      }
    }),
  );
  return Object.fromEntries(entries);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
