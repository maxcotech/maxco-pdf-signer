/**
 * Request schemas for POST /api/v1/sign.
 *
 * These serve two purposes from one definition: they generate the OpenAPI
 * request body documentation, and they are the runtime validator the route
 * applies before anything reaches the library.
 *
 * Wire format note: the endpoint takes multipart/form-data, so `metadata`,
 * `appearance` and `position` arrive as *strings containing JSON*, not as
 * structured parts. Each is modelled as `z.string() -> JSON.parse -> object
 * schema`, with an `.openapi()` override so the spec advertises the honest wire
 * type (a string with contentMediaType: application/json) while validation
 * still happens against the real object shape.
 */
import type { ZodOpenAPIMetadata } from '@asteasolutions/zod-to-openapi';
import { z } from '../openapi/zod';
import { registry } from '../openapi/registry';

/** ISO 8601 timestamp. Converted to a Date by the route, not by the schema. */
const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO 8601 date-time string')
  .openapi({ format: 'date-time', example: '2026-09-01T12:00:00.000Z' });

export const SigningMetadataSchema = registry.register(
  'SigningMetadata',
  z
    .object({
      reason: z.string().max(512).optional().openapi({
        description: 'Written to the signature dictionary /Reason.',
        example: 'Approved for release',
      }),
      location: z.string().max(512).optional().openapi({ example: 'New York, USA' }),
      contactInfo: z.string().max(512).optional().openapi({ example: 'signing@example.com' }),
      signerName: z.string().max(512).optional().openapi({ example: 'Jane Smith' }),
      signingDate: isoDateTime.optional().openapi({
        description:
          'Signing time embedded in the PKCS#7 signedAttrs and the /M entry. Defaults to the server clock.',
        format: 'date-time',
        example: '2026-09-01T12:00:00.000Z',
      }),
      placeholderSizeBytes: z.number().int().min(512).max(1_000_000).optional().openapi({
        description:
          'Size of the /Contents slot in bytes. Raise this if signing fails with SIGNATURE_OVERFLOW. ' +
          'Rough guide: single certificate 3-4KB, three-certificate chain 10-14KB.',
        example: 16384,
      }),
      subFilter: z.enum(['adbe.pkcs7.detached', 'ETSI.CAdES.detached']).optional().openapi({
        description: 'Signature /SubFilter. Use ETSI.CAdES.detached for eIDAS/PAdES contexts.',
      }),
    })
    .strict(),
);

const appearanceShape = z
  .object({
    svgString: z.string().min(1).optional().openapi({
      description:
        'A complete SVG document. MUST contain a viewBox attribute — the renderer requires it. ' +
        'Mutually exclusive with `text`.',
      example: '<svg viewBox="0 0 300 80" xmlns="http://www.w3.org/2000/svg"><path d="M10,60 C40,10 80,10 120,60" stroke="#000" fill="none" stroke-width="2"/></svg>',
    }),
    text: z.string().min(1).max(200).optional().openapi({
      description:
        'Text rendered in the bundled Great Vibes script font. Mutually exclusive with `svgString`.',
      example: 'Jane Smith',
    }),
    fontSize: z.number().positive().max(400).optional().openapi({
      description: 'Text mode only. Default 32.',
      example: 36,
    }),
    color: z.string().optional().openapi({
      description: 'CSS color for text mode. Default #1a1a2e. Ignored when svgString is used.',
      example: '#1a3a6e',
    }),
    renderScale: z.number().min(1).max(4).optional().openapi({
      description: 'Rasterisation scale factor relative to the stamp size. Default 2.',
      example: 2,
    }),
  })
  .strict();

export const SignatureAppearanceSchema = registry.register(
  'SignatureAppearance',
  appearanceShape.openapi({
    description: 'Visual stamp definition. Provide exactly one of `svgString` or `text`.',
  }),
);

/** Enforces the exactly-one-source rule the library would otherwise reject later. */
const appearanceValidated = appearanceShape.refine(
  (a) => (a.svgString === undefined) !== (a.text === undefined),
  'Provide exactly one of "svgString" or "text" — not both, not neither',
);

export const StampPositionSchema = registry.register(
  'StampPosition',
  z
    .object({
      page: z.number().int().min(0).openapi({ description: 'Page index, 0-based.', example: 0 }),
      x: z.number().openapi({ description: 'Points from the LEFT page edge.', example: 50 }),
      y: z.number().openapi({
        description:
          'Points from the BOTTOM page edge — PDF origin is bottom-left, unlike browser canvas.',
        example: 40,
      }),
      width: z.number().positive().openapi({ example: 200 }),
      height: z.number().positive().openapi({ example: 60 }),
    })
    .strict()
    .openapi({
      description:
        'Stamp placement in PDF points (1/72 inch), bottom-left origin. ' +
        'Page sizes: A4 595.28x841.89, Letter 612x792, Legal 612x1008.',
    }),
);

/**
 * `contentMediaType` is an OpenAPI 3.1 keyword. zod-to-openapi types its metadata
 * argument as the *intersection* of the 3.0 and 3.1 schema objects, so 3.1-only
 * keywords are not in the type even though the generator passes them straight
 * through to the emitted document. Hence the assertion.
 */
function jsonStringMetadata(componentName: string, description: string, example: string) {
  return {
    type: 'string',
    contentMediaType: 'application/json',
    // JSON Schema 2020-12 keyword: says what the JSON inside the string must look
    // like, which is what links the form field to its documented component.
    contentSchema: { $ref: `#/components/schemas/${componentName}` },
    description,
    example,
  } as Partial<ZodOpenAPIMetadata<string>>;
}

/**
 * Wraps an object schema so it validates a JSON-encoded string on the wire while
 * documenting itself as a string carrying application/json.
 */
function jsonEncoded<T extends z.ZodTypeAny>(inner: T, componentName: string, example: string) {
  return z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Must be a valid JSON string' });
        return z.NEVER;
      }
    })
    .pipe(inner)
    .openapi(
      jsonStringMetadata(
        componentName,
        `JSON-encoded ${componentName} object, sent as a form field value.`,
        example,
      ),
    );
}

/** The three JSON-encoded form fields, shared by the runtime and documented schemas. */
const jsonFormFields = {
  metadata: jsonEncoded(
    SigningMetadataSchema,
    'SigningMetadata',
    '{"reason":"Approved for release","location":"New York, USA"}',
  ).optional(),
  appearance: jsonEncoded(
    appearanceValidated,
    'SignatureAppearance',
    '{"text":"Jane Smith","fontSize":36}',
  ).optional(),
  position: jsonEncoded(
    StampPositionSchema,
    'StampPosition',
    '{"page":0,"x":50,"y":40,"width":200,"height":60}',
  ).optional(),
};

/**
 * Runtime validator for req.body (multer has already stripped the file part).
 * The cross-field rule cannot be expressed in the OpenAPI schema, so it is also
 * stated in the request body description.
 */
export const SignRequestBodySchema = z.object(jsonFormFields).superRefine((body, ctx) => {
  if (body.appearance !== undefined && body.position === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['position'],
      message: 'position is required when appearance is provided',
    });
  }
});

/** Documented multipart body, including the file part multer handles. */
export const SignRequestSchema = registry.register(
  'SignRequest',
  z.object({
    pdf: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'The PDF to sign. Rejected with 413 above the server MAX_UPLOAD_MB limit.',
    }),
    ...jsonFormFields,
  }),
);

/** Field names carrying JSON, used to normalise empty strings to "absent". */
export const JSON_FORM_FIELDS = Object.keys(jsonFormFields) as (keyof typeof jsonFormFields)[];
