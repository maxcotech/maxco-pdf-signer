/**
 * OpenAPI path definitions.
 *
 * One block per route, mirroring server/app.ts and server/routes/. When you add
 * a route, add it here too — test/openapi.test.ts walks the live Express router
 * and fails if a mounted route is missing from this file.
 */
import { registry, API_KEY_SECURITY } from './registry';
import {
  ErrorResponseSchema,
  HealthResponseSchema,
  SignatureOverflowResponseSchema,
} from '../schemas/common';
import { SignRequestSchema } from '../schemas/sign';
import { z } from './zod';

const jsonError = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

let registered = false;

export function registerPaths(): void {
  if (registered) return;
  registered = true;

  registry.registerPath({
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    tags: ['Service'],
    summary: 'Liveness probe',
    description: 'Unauthenticated. Use for container health checks and load-balancer probes.',
    security: [],
    responses: {
      200: {
        description: 'The service is up.',
        content: { 'application/json': { schema: HealthResponseSchema } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/sign',
    operationId: 'signPdf',
    tags: ['Signing'],
    summary: 'Sign a PDF with the server certificate',
    description: [
      'Applies an optional visible stamp and then a PKCS#7/CMS detached signature, using the',
      'PKCS#12 certificate configured on the server (P12_PATH / P12_PASSWORD). The stamp is',
      'rendered *before* hashing, so the stamp pixels fall inside the signed ByteRange and any',
      'later modification is detectable in Adobe Acrobat Reader.',
      '',
      'Because the body is multipart/form-data, `metadata`, `appearance` and `position` are sent',
      'as form field values containing JSON. `position` is required whenever `appearance` is',
      'present; omit both to produce an invisible cryptographic-only signature.',
    ].join('\n'),
    security: API_KEY_SECURITY,
    request: {
      body: {
        required: true,
        content: { 'multipart/form-data': { schema: SignRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'The signed PDF.',
        headers: z.object({
          'X-Document-Hash': z.string().openapi({
            description:
              'Hex SHA-256 of the concatenated ByteRange segments. Recompute it from the returned ' +
              'PDF and X-Byte-Range to verify the response independently.',
            example: 'a3f1c0...',
          }),
          'X-Byte-Range': z.string().openapi({
            description:
              'JSON array [offset1, length1, offset2, length2] — the signed byte spans. ' +
              'The gap between them is the /Contents hex slot, which is not signed.',
            example: '[0,12043,28429,3517]',
          }),
          'X-Signing-Time': z.string().openapi({
            description: 'UTC ISO 8601 timestamp embedded in the signature.',
            example: '2026-09-01T12:00:00.000Z',
          }),
        }),
        content: {
          'application/pdf': {
            schema: z.string().openapi({ type: 'string', format: 'binary' }),
          },
        },
      },
      400: {
        description:
          'Bad request: no PDF part (MISSING_FILE), a field failed validation (VALIDATION_ERROR, ' +
          'with per-field `details`), the PDF could not be parsed (INVALID_PDF), the stamp was ' +
          'rejected (INVALID_APPEARANCE / INVALID_POSITION / MISSING_POSITION), or the signature ' +
          'did not fit the placeholder (SIGNATURE_OVERFLOW).',
        content: {
          'application/json': {
            schema: z.union([ErrorResponseSchema, SignatureOverflowResponseSchema]),
          },
        },
      },
      401: jsonError('Missing or invalid x-api-key header (UNAUTHORIZED).'),
      413: jsonError('The uploaded PDF exceeds the server MAX_UPLOAD_MB limit (PAYLOAD_TOO_LARGE).'),
      500: jsonError(
        'Server-side failure: certificate could not be loaded (INVALID_CERTIFICATE), the ByteRange ' +
          'invariant failed (BYTE_RANGE_ERROR), or an unexpected error (INTERNAL_ERROR).',
      ),
    },
  });
}
