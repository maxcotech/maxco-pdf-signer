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
 * Fallback for a preflight that does not name the headers it wants (rare — a
 * browser always sends Access-Control-Request-Headers when a non-safelisted
 * header is involved). `x-api-key` is the load-bearing entry: it is not
 * CORS-safelisted, so every authenticated request preflights.
 */
const DEFAULT_ALLOWED_HEADERS = ['Content-Type', 'x-api-key'].join(', ');

const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS'].join(', ');

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
 *
 * **The origin allowlist is the security boundary, not the header list.** Once an
 * origin is trusted, a preflight's Access-Control-Request-Headers is echoed back
 * verbatim, so a client is free to add its own headers (`timezone`,
 * `x-request-id`, tracing headers, whatever an HTTP wrapper injects) without a
 * server change. Enumerating them instead buys nothing — a caller that is
 * already allowed to POST a document can send any header it likes over curl —
 * and every omission surfaces as an opaque browser-side "request header field X
 * is not allowed" that only the frontend developer can see.
 */
export function cors(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.header('origin');

    if (origin && allowed.has(origin)) {
      // Echo what this preflight asked for. Header names are reflected, never
      // interpreted, so there is nothing to inject: the browser only compares
      // this list against the names it already sent.
      const requested = req.header('access-control-request-headers');

      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': requested ?? DEFAULT_ALLOWED_HEADERS,
        'Access-Control-Expose-Headers': EXPOSED_HEADERS,
        'Access-Control-Max-Age': '86400',
      });
    }

    // The reply varies by Origin whether or not this one matched, so say so
    // unconditionally — otherwise a shared cache can serve an allowlisted
    // origin's response (or the absence of one) to a different origin. Reflecting
    // the requested headers makes the preflight reply vary by those too.
    res.vary('Origin');
    res.vary('Access-Control-Request-Headers');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
