import { Router } from 'express';
import multer from 'multer';
import { inspectPdf } from '../../src/index';
import type { ServerConfig } from '../config';

/**
 * POST /api/v1/documents/inspect — read-only document introspection.
 *
 * A client cannot build a StampPosition without knowing how big the target page
 * is, so this is the first call in the signing flow: inspect, place, sign. It is
 * also where an unsignable upload should be caught — an encrypted PDF cannot be
 * signed at all, and `signatureCount > 0` means the file was signed before.
 *
 * Nothing is persisted; the buffer is parsed in memory and discarded.
 */
export function createInspectRouter(config: ServerConfig): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: config.maxUploadBytes } });

  router.post('/documents/inspect', upload.single('pdf'), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing "pdf" file field', code: 'MISSING_FILE' });
        return;
      }

      res.json(await inspectPdf(req.file.buffer));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
