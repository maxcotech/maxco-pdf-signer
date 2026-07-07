import { RequestHandler } from 'express';
import crypto from 'crypto';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function apiKeyAuth(expectedKey: string): RequestHandler {
  return (req, res, next) => {
    const provided = req.header('x-api-key');
    if (!provided || !safeEqual(provided, expectedKey)) {
      res.status(401).json({ error: 'Missing or invalid x-api-key header', code: 'UNAUTHORIZED' });
      return;
    }
    next();
  };
}
