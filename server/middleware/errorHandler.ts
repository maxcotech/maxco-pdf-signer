import { ErrorRequestHandler } from 'express';
import { PdfSignerError, SignatureOverflowError } from '../../src/index';

// Client-fault errors (bad input) map to 400; anything else is a server-side 500.
const CLIENT_FAULT_CODES = new Set([
  'MISSING_POSITION',
  'INVALID_APPEARANCE',
  'INVALID_POSITION',
  'INVALID_PDF',
  'SIGNATURE_OVERFLOW',
]);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof PdfSignerError) {
    const status = CLIENT_FAULT_CODES.has(err.code) ? 400 : 500;
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err instanceof SignatureOverflowError) {
      body.actualBytes = err.actualBytes;
      body.allocatedBytes = err.allocatedBytes;
    }
    res.status(status).json(body);
    return;
  }

  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'Uploaded PDF exceeds the size limit', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }

  if (typeof err?.statusCode === 'number') {
    res.status(err.statusCode).json({ error: err.message, code: 'BAD_REQUEST' });
    return;
  }

  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
};
