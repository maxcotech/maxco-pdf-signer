/**
 * The shared OpenAPI component registry.
 *
 * Schema modules register their components here at import time; `document.ts`
 * turns the accumulated definitions into an OpenAPI document. Keeping the
 * registry in its own module avoids a circular import between the schemas
 * (which need to register) and the document builder (which needs the schemas).
 */
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

// Side-effect import: patches Zod before any schema module runs.
import './zod';

export const registry = new OpenAPIRegistry();

/**
 * The only auth scheme on this API: a shared secret in the `x-api-key` header,
 * compared in constant time by `server/middleware/apiKeyAuth.ts`.
 */
export const apiKeyScheme = registry.registerComponent('securitySchemes', 'apiKeyAuth', {
  type: 'apiKey',
  in: 'header',
  name: 'x-api-key',
  description:
    'Shared secret configured as the API_KEY environment variable on the server. ' +
    'Required on every /api/v1 route. Compared in constant time; a mismatch returns 401.',
});

/** Security requirement to attach to authenticated paths. */
export const API_KEY_SECURITY = [{ [apiKeyScheme.name]: [] }];
