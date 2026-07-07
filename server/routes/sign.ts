import { Router } from 'express';
import multer from 'multer';
import { PdfSigner } from '../../src/index';
import type { ServerConfig } from '../config';

function parseJsonField<T>(raw: unknown, fieldName: string): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    throw Object.assign(new Error(`Field "${fieldName}" must be valid JSON`), {
      statusCode: 400,
    });
  }
}

export function createSignRouter(config: ServerConfig): Router {
  const router = Router();
  const upload = multer({ limits: { fileSize: config.maxUploadBytes } });
  const signer = new PdfSigner({
    defaultPlaceholderSize: config.defaultPlaceholderSize,
    hsmTimeoutMs: config.hsmTimeoutMs,
  });

  router.post('/sign', upload.single('pdf'), async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing "pdf" file field', code: 'MISSING_FILE' });
        return;
      }

      const metadata = parseJsonField<Record<string, unknown>>(req.body.metadata, 'metadata') ?? {};
      const appearance = parseJsonField(req.body.appearance, 'appearance');
      const position = parseJsonField(req.body.position, 'position');
      const signingDate = metadata.signingDate ? new Date(metadata.signingDate as string) : undefined;

      const result = await signer.signLocal({
        pdfBuffer: req.file.buffer,
        p12Path: config.p12Path,
        p12Password: config.p12Password,
        appearance: appearance as never,
        position: position as never,
        reason: metadata.reason as string | undefined,
        location: metadata.location as string | undefined,
        contactInfo: metadata.contactInfo as string | undefined,
        signerName: metadata.signerName as string | undefined,
        signingDate,
        placeholderSizeBytes: metadata.placeholderSizeBytes as number | undefined,
        subFilter: metadata.subFilter as 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached' | undefined,
      });

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="signed.pdf"',
        'X-Document-Hash': result.documentHash,
        'X-Byte-Range': JSON.stringify(result.byteRange),
        'X-Signing-Time': result.signingTime,
      });
      res.send(result.signedPdf);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
