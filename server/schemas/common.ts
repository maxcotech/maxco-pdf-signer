/**
 * Response schemas shared by every route: the error envelope and its code enum.
 *
 * The code list is the union of two sources, and `test/openapi.test.ts` asserts
 * the first half stays in sync with the library:
 *   - LIBRARY_ERROR_CODES  — thrown by src/errors.ts (plus HSM_ERROR from CryptoStore)
 *   - TRANSPORT_ERROR_CODES — produced only by the HTTP layer in server/
 */
import { z } from '../openapi/zod';
import { registry } from '../openapi/registry';

/** Codes originating in the library. Mirrors src/errors.ts — kept honest by a test. */
export const LIBRARY_ERROR_CODES = [
  'SIGNATURE_OVERFLOW',
  'BYTE_RANGE_ERROR',
  'INVALID_CERTIFICATE',
  'INVALID_PDF',
  'INVALID_APPEARANCE',
  'INVALID_POSITION',
  'MISSING_POSITION',
  'HSM_TIMEOUT',
  // Not a dedicated class: CryptoStore wraps non-PdfSignerError HSM failures
  // in a plain PdfSignerError carrying this code.
  'HSM_ERROR',
] as const;

/** Codes produced only by the HTTP transport layer. */
export const TRANSPORT_ERROR_CODES = [
  'UNAUTHORIZED',
  'MISSING_FILE',
  'VALIDATION_ERROR',
  'PAYLOAD_TOO_LARGE',
  'BAD_REQUEST',
  'INTERNAL_ERROR',
] as const;

export const ERROR_CODES = [...LIBRARY_ERROR_CODES, ...TRANSPORT_ERROR_CODES] as const;

export const ErrorCodeSchema = registry.register(
  'ErrorCode',
  z.enum(ERROR_CODES).openapi({
    description:
      'Stable machine-readable error identifier. Branch on this rather than on the message text.',
  }),
);

const validationIssue = z.object({
  field: z.string().openapi({
    description: 'Dotted path to the offending field, or "(body)" for a whole-body issue.',
    example: 'position.page',
  }),
  message: z.string().openapi({ example: 'Expected number, received string' }),
});

export const ErrorResponseSchema = registry.register(
  'ErrorResponse',
  z
    .object({
      error: z.string().openapi({
        description: 'Human-readable description. Not stable — do not parse.',
        example: 'Invalid appearance: svgString must include a viewBox attribute',
      }),
      code: ErrorCodeSchema,
      details: z.array(validationIssue).optional().openapi({
        description: 'Present only on VALIDATION_ERROR: one entry per failed field.',
      }),
    })
    .openapi({ description: 'Standard error envelope returned by every non-2xx response.' }),
);

export const SignatureOverflowResponseSchema = registry.register(
  'SignatureOverflowResponse',
  z
    .object({
      error: z.string().openapi({
        example: 'PKCS#7 (17004 bytes) exceeds placeholder (16384 bytes). Set placeholderSizeBytes >= 17516.',
      }),
      code: z.literal('SIGNATURE_OVERFLOW'),
      actualBytes: z.number().int().openapi({
        description: 'Size of the assembled PKCS#7 container.',
        example: 17004,
      }),
      allocatedBytes: z.number().int().openapi({
        description: 'Size of the /Contents placeholder it did not fit into.',
        example: 16384,
      }),
    })
    .openapi({
      description:
        'Returned when the certificate chain is larger than the allocated /Contents slot. ' +
        'Retry with metadata.placeholderSizeBytes set to actualBytes + 512 or higher.',
    }),
);

export const HealthResponseSchema = registry.register(
  'HealthResponse',
  z.object({
    status: z.literal('ok'),
    service: z.literal('pdf-signer-api'),
  }),
);
