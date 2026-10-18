import { Router } from 'express';
import { aggregateHealth, collectHealth } from '@agentic-ai/agent';
import type { Dependencies } from '../container.js';

export function createHealthRouter(deps: Dependencies): Router {
  const router = Router();

  /** Liveness: the process is up. Never touches dependencies. */
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
  });

  /** Readiness: per-component status. `down` anywhere -> 503, `degraded` still serves traffic. Details are not exposed. */
  router.get('/ready', async (_req, res) => {
    const reports = await collectHealth(deps.healthComponents);
    const status = aggregateHealth(reports);
    // The database is mandatory; every other dependency degrades gracefully.
    const dbDown = reports.database?.status === 'down';
    res.status(dbDown ? 503 : 200).json({
      status: dbDown ? 'down' : status,
      components: Object.fromEntries(Object.entries(reports).map(([name, r]) => [name, r.status])),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
