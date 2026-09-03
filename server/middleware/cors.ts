import { RequestHandler } from 'express';

/**
 * Response headers the browser must be allowed to read. Without these listed in
 * Access-Control-Expose-Headers a cross-origin `fetch` sees an empty header map,
 * so `pdf-signer/client` would return an empty documentHash / byteRange /
 * stampRect for every successful sign — a silent, confusing failure rather than
 * a CORS error.
 */
const EXPOSED_HEADERS = [
  'X-Document-Hash',
  'X-Byte-Range',
  'X-Signing-Time',
  'X-Stamp-Rect',
  'Content-Disposition',
].join(', ');

/**
 * Request headers a browser client sends. `x-api-key` is the load-bearing one:
 * it is not a CORS-safelisted header, so every authenticated request triggers a
 * preflight that fails unless it is named here.
 */
const ALLOWED_HEADERS = ['Content-Type', 'x-api-key'].join(', ');

const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'].join(', ');

/**
 * Allowlist CORS. Mount it ABOVE `apiKeyAuth` — a preflight `OPTIONS` request
 * carries no `x-api-key` header (the browser strips everything but the CORS
 * negotiation headers), so an authenticated preflight would 401 and the real
 * request would never be sent.
 *
 * Unlisted origins are not rejected here; they simply get no
 * Access-Control-Allow-Origin header, and the browser enforces the block. This
 * keeps non-browser callers (curl, server-to-server, the test suite) working,
 * since they send no Origin at all.
 */
export function cors(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.header('origin');

    if (origin && allowed.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        'Access-Control-Expose-Headers': EXPOSED_HEADERS,
        'Access-Control-Max-Age': '86400',
      });
    }

    // The reply varies by Origin whether or not this one matched, so say so
    // unconditionally — otherwise a shared cache can serve an allowlisted
    // origin's response (or the absence of one) to a different origin.
    res.vary('Origin');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
