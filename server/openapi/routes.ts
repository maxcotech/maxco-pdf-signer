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
import { InspectRequestSchema, InspectResponseSchema } from '../schemas/inspect';
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
    path: '/api/v1/documents/inspect',
    operationId: 'inspectDocument',
    tags: ['Documents'],
    summary: 'Read a PDF page geometry without modifying it',
    description: [
      'Returns the page count, the size of every page in PDF points, and each page /Rotate —',
      'the facts a client needs before it can build a `position` for POST /api/v1/sign at all.',
      'Call this first: inspect, place, sign.',
      '',
      'Also reports whether the document is encrypted (this service cannot sign a',
      'password-protected PDF) and how many signatures it already carries, which are the two',
      'reasons to reject an upload before a user has filled anything in.',
      '',
      'Read-only. The uploaded document is parsed in memory and discarded with the response —',
      'nothing is stored, modified or signed.',
    ].join('\n'),
    security: API_KEY_SECURITY,
    request: {
      body: {
        required: true,
        content: { 'multipart/form-data': { schema: InspectRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'What the server could determine about the document.',
        content: { 'application/json': { schema: InspectResponseSchema } },
      },
      400: jsonError(
        'No PDF part was sent (MISSING_FILE), or the upload could not be parsed as a PDF ' +
          '(INVALID_PDF). An encrypted PDF is NOT an error here — it returns 200 with ' +
          '`encrypted: true` so the caller can explain the rejection.',
      ),
      401: jsonError('Missing or invalid x-api-key header (UNAUTHORIZED).'),
      413: jsonError('The uploaded PDF exceeds the server MAX_UPLOAD_MB limit (PAYLOAD_TOO_LARGE).'),
      500: jsonError('Unexpected server-side failure (INTERNAL_ERROR).'),
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
      'as form field values containing JSON — a string per field, not a nested object part.',
      '`position` is required whenever `appearance` is present; omit both to produce an',
      'invisible cryptographic-only signature.',
      '',
      '`position` defaults to PDF points with a bottom-left origin. A rectangle taken from a',
      'browser is neither, so declare the space it was measured in — `origin: "top-left"`,',
      '`units: "px"`, `viewportWidth: <rendered page width>` — and the server converts it',
      'against the real page geometry. The rectangle finally used comes back in X-Stamp-Rect.',
      'Call POST /api/v1/documents/inspect first for the page sizes.',
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
          // Optional, unlike the other three: a cryptographic-only signature
          // draws no stamp, so there is no rectangle to report.
          'X-Stamp-Rect': z
            .string()
            .optional()
            .openapi({
              description:
                'Present only when a stamp was applied. JSON object {page, x, y, width, height} ' +
                'giving the rectangle actually drawn, in PDF points with a bottom-left origin, ' +
                'after any origin/units conversion. Compare it against what your UI drew to ' +
                'confirm placement without re-parsing the PDF.',
              example: '{"page":0,"x":50,"y":40,"width":200,"height":60}',
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
