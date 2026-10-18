import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { API_BASE } from './config/api.js';
import { setupSwagger } from './config/swagger.js';
import type { Dependencies } from './container.js';
import { redactUrl } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createAuthRouter } from './routes/authRoutes.js';
import { createChatRouter } from './routes/chatRoutes.js';
import { createDocumentRouter } from './routes/documentRoutes.js';
import { createHealthRouter } from './routes/healthRoutes.js';
import { createRagRouter } from './routes/ragRoutes.js';

export function createApp(deps: Dependencies): Express {
  const { config, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === `${API_BASE}/health` },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Non-browser clients send no Origin; browsers must be on the allowlist.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '3mb' }));

  if (config.docsEnabled) setupSwagger(app);

  const v1 = Router();
  v1.use(createHealthRouter(deps));
  v1.use('/auth', createAuthRouter(deps));
  v1.use('/chat', createChatRouter(deps));
  v1.use('/documents', createDocumentRouter(deps));
  v1.use('/rag', createRagRouter(deps));
  app.use(API_BASE, v1);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
