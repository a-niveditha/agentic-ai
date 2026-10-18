import multer from 'multer';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { AppError, badRequest } from '../lib/errors.js';
import { API_BASE } from '../config/api.js';
import { requireAuth, currentUserId, type AuthenticatedRequest } from '../middleware/auth.js';
import { createLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import type { Dependencies } from '../container.js';

const IdParams = z.object({ id: z.string().uuid() });
const JsonBody = z
  .object({
    text: z.string().min(1).max(2_000_000).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are supported').optional(),
  })
  .refine((b) => Boolean(b.text) !== Boolean(b.url), { message: "Provide exactly one of 'text' or 'url'" });

/** 202: the document exists (status `processing`) and is indexed in the background; poll `Location` for the outcome. */
function accepted(res: Response, document: { id: string }) {
  res.status(202).location(`${API_BASE}/documents/${document.id}`).json({ document });
}

export function createDocumentRouter(deps: Dependencies): Router {
  const router = Router();
  const { documents, tokens, config } = deps;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 } });
  const limiter = createLimiter({ perMinute: config.RATE_LIMIT_DOCS_PER_MIN, keyByUser: true });

  router.use(requireAuth(tokens));

  router.get('/', async (req: AuthenticatedRequest, res, next) => {
    try {
      res.json({ documents: await documents.list(currentUserId(req)), supportedExtensions: documents.supportedExtensions() });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', validate(IdParams, 'params'), async (req: AuthenticatedRequest, res, next) => {
    try {
      res.json({ document: await documents.get(currentUserId(req), req.params.id!) });
    } catch (err) {
      next(err);
    }
  });

  /** multipart/form-data with a `file` field, or JSON `{ text, title? }` / `{ url }`. */
  router.post('/', limiter, upload.single('file'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const userId = currentUserId(req);
      if (req.file) {
        return void accepted(res, await documents.uploadFile(userId, req.file));
      }
      const parsed = JsonBody.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest("Send a 'file' upload, or JSON with exactly one of 'text' or 'url'.", 'validation_error');
      const { text, title, url } = parsed.data;
      const document = url ? await documents.addUrl(userId, url) : await documents.addText(userId, { title: title ?? 'Pasted text', text: text! });
      accepted(res, document);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/retry', limiter, validate(IdParams, 'params'), async (req: AuthenticatedRequest, res, next) => {
    try {
      accepted(res, await documents.retry(currentUserId(req), req.params.id!));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', validate(IdParams, 'params'), async (req: AuthenticatedRequest, res, next) => {
    try {
      await documents.remove(currentUserId(req), req.params.id!);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export { AppError };
