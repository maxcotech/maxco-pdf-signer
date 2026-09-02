import { Router } from 'express';
import multer from 'multer';
import { PdfSigner } from '../../src/index';
import type { ServerConfig } from '../config';
import { JSON_FORM_FIELDS, SignRequestBodySchema } from '../schemas/sign';

/**
 * multer gives every text field as a string, and an omitted field as undefined.
 * A field submitted but left blank ('') means "not provided" here — normalise it
 * so the optional() schemas treat it that way rather than failing JSON parsing.
 */
function normaliseFormBody(body: Record<string, unknown>): Record<string, unknown> {
  const normalised: Record<string, unknown> = { ...body };
  for (const field of JSON_FORM_FIELDS) {
    if (normalised[field] === '' || normalised[field] === null) {
      delete normalised[field];
    }
  }
  return normalised;
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

      // Single source of truth with the OpenAPI request schema: parses the
      // JSON-encoded form fields, type-checks every value, and enforces the
      // cross-field rules before the library is touched.
      const parsed = SignRequestBodySchema.safeParse(normaliseFormBody(req.body ?? {}));
      if (!parsed.success) {
        res.status(400).json({
          error: 'Request validation failed',
          code: 'VALIDATION_ERROR',
          details: parsed.error.issues.map((issue) => ({
            field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
            message: issue.message,
          })),
        });
        return;
      }

      const { metadata, appearance, position } = parsed.data;

      const result = await signer.signLocal({
        pdfBuffer: req.file.buffer,
        p12Path: config.p12Path,
        p12Password: config.p12Password,
        appearance,
        position,
        reason: metadata?.reason,
        location: metadata?.location,
        contactInfo: metadata?.contactInfo,
        signerName: metadata?.signerName,
        signingDate: metadata?.signingDate ? new Date(metadata.signingDate) : undefined,
        placeholderSizeBytes: metadata?.placeholderSizeBytes,
        subFilter: metadata?.subFilter,
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
