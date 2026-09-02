/**
 * Assembles the OpenAPI document from the component registry.
 *
 * Deliberately free of any dependency on server/config.ts, so the spec can be
 * emitted (scripts/emit-openapi.ts) without API_KEY, P12_PATH or any other
 * runtime secret being present.
 */
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { registry } from './registry';
import { registerPaths } from './routes';

/**
 * Version of the HTTP contract — NOT the npm package version. Bump this when the
 * request or response shape of an endpoint changes in a way clients would notice.
 * The URL prefix (/api/v1) tracks breaking changes.
 */
export const API_CONTRACT_VERSION = '1.0.0';

let cached: OpenAPIObject | undefined;

export function buildOpenApiDocument(): OpenAPIObject {
  if (cached) return cached;

  registerPaths();

  cached = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'pdf-signer API',
      version: API_CONTRACT_VERSION,
      description: [
        'HTTP wrapper around the `pdf-signer` library: applies a visible signature stamp and a',
        'PKCS#7/CMS detached cryptographic seal to a PDF in one call.',
        '',
        'Only the local PKCS#12 signing path (Path A) is exposed over HTTP. The remote-HSM path',
        'requires a caller-supplied signing callback and is available through the library only.',
        '',
        'Authenticate with the `x-api-key` header on every `/api/v1` route.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'This instance' }],
    tags: [
      { name: 'Signing', description: 'PDF signature operations' },
      { name: 'Service', description: 'Operational endpoints' },
    ],
  });

  return cached;
}
