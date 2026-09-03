/**
 * Response schema for POST /api/v1/documents/inspect.
 *
 * The endpoint exists so a client can learn the page geometry it needs in order
 * to build a StampPosition at all, without shipping its own PDF parser. It is
 * read-only: the uploaded document is not stored, modified or signed.
 */
import { z } from '../openapi/zod';
import { registry } from '../openapi/registry';

export const PdfPageInfoSchema = registry.register(
  'PdfPageInfo',
  z
    .object({
      index: z.number().int().openapi({
        description: 'Page index, 0-based — the value to send as StampPosition.page.',
        example: 0,
      }),
      widthPts: z.number().openapi({
        description:
          'Page width in PDF points (1/72 inch) in user space. Stamp coordinates are in this ' +
          'space, so this is the number to do stamp arithmetic against.',
        example: 595.28,
      }),
      heightPts: z.number().openapi({
        description: 'Page height in PDF points in user space.',
        example: 841.89,
      }),
      rotation: z.number().int().openapi({
        description:
          'Page /Rotate, normalised to 0, 90, 180 or 270. A non-zero value means a top-left ' +
          'or pixel rectangle cannot be converted for this page — send user-space points instead.',
        example: 0,
      }),
      displayWidthPts: z.number().openapi({
        description:
          'Width of the box a viewer displays: swapped with the height when rotation is 90 or ' +
          '270. A pixel rectangle measured over a rendered page is relative to this box.',
        example: 595.28,
      }),
      displayHeightPts: z.number().openapi({
        description: 'Height of the box a viewer displays. See displayWidthPts.',
        example: 841.89,
      }),
    })
    .openapi({ description: 'Geometry of a single page.' }),
);

export const InspectResponseSchema = registry.register(
  'InspectResponse',
  z
    .object({
      sizeBytes: z.number().int().openapi({
        description: 'Size of the uploaded PDF in bytes.',
        example: 24576,
      }),
      pageCount: z.number().int().openapi({
        description: 'Number of pages. 0 when the document is encrypted and could not be read.',
        example: 3,
      }),
      pages: z.array(PdfPageInfoSchema).openapi({
        description: 'Per-page geometry, in document order. Empty when encrypted.',
      }),
      encrypted: z.boolean().openapi({
        description:
          'True when the PDF is password-protected. Such a document cannot be signed — reject ' +
          'it at upload and ask for an unprotected copy.',
        example: false,
      }),
      signatureCount: z.number().int().openapi({
        description:
          'Existing signature dictionaries found anywhere in the file, including earlier ' +
          'incremental revisions. Non-zero means the document was signed before; signing again ' +
          'is legitimate but is rarely intended for what an app treats as a fresh upload.',
        example: 0,
      }),
      signable: z.boolean().openapi({
        description: 'Whether this document can be submitted to POST /api/v1/sign as-is.',
        example: true,
      }),
    })
    .openapi({
      description:
        'What the server can determine about an uploaded PDF without modifying it. Nothing is ' +
        'stored: the document is parsed in memory and discarded with the response.',
    }),
);

/** Documented multipart body — the file part multer handles. */
export const InspectRequestSchema = registry.register(
  'InspectRequest',
  z.object({
    pdf: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'The PDF to inspect. Rejected with 413 above the server MAX_UPLOAD_MB limit.',
    }),
  }),
);
