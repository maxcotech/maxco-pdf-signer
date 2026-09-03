/**
 * `pdf-signer/client` — a typed client for the pdf-signer REST API.
 *
 * The wire format of POST /api/v1/sign is honest but easy to get wrong by hand:
 * multipart/form-data whose `metadata`, `appearance` and `position` parts are
 * *strings containing JSON*, not nested objects. Appending an object to a
 * FormData stringifies it to "[object Object]" and the request fails validation
 * for a reason that does not obviously point at the mistake. This module exists
 * so that no caller has to know that: pass real objects, get a Buffer back.
 *
 * It also raises the two things worth knowing after a signing call — where the
 * stamp actually landed, and the document hash — from response headers into the
 * returned object, and turns every non-2xx response into a typed
 * PdfSignerApiError carrying the server's stable `code`.
 *
 * Dependency-free: uses the global fetch, FormData and Blob available in Node 18+
 * and in browsers.
 *
 * @example
 * ```typescript
 * import { PdfSignerClient } from 'pdf-signer/client';
 *
 * const client = new PdfSignerClient({
 *   baseUrl: 'https://signer.internal',
 *   apiKey: process.env.PDF_SIGNER_API_KEY!,
 * });
 *
 * // 1. Learn the page geometry the stamp rectangle is relative to
 * const { pages, encrypted } = await client.inspect(pdfBuffer);
 * if (encrypted) throw new Error('Password-protected PDFs cannot be signed');
 *
 * // 2. Sign, sending the rectangle in whatever space you measured it in
 * const { signedPdf, stampRect } = await client.sign({
 *   pdf: pdfBuffer,
 *   appearance: { text: 'Jane Smith' },
 *   position: {
 *     page: 0, x: 120, y: 80, width: 200, height: 60,
 *     origin: 'top-left', units: 'px', viewportWidth: 1000,
 *   },
 *   metadata: { reason: 'Approved', location: 'Lagos, Nigeria' },
 * });
 * ```
 */

/** Stable machine-readable error identifiers. Branch on these, never on message text. */
export type ErrorCode =
  // Produced by the signing library
  | 'SIGNATURE_OVERFLOW'
  | 'BYTE_RANGE_ERROR'
  | 'INVALID_CERTIFICATE'
  | 'INVALID_PDF'
  | 'INVALID_APPEARANCE'
  | 'INVALID_POSITION'
  | 'MISSING_POSITION'
  | 'HSM_TIMEOUT'
  | 'HSM_ERROR'
  // Produced by the HTTP transport
  | 'UNAUTHORIZED'
  | 'MISSING_FILE'
  | 'VALIDATION_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'BAD_REQUEST'
  | 'INTERNAL_ERROR';

/** One field-level complaint from a VALIDATION_ERROR response. */
export interface ValidationIssue {
  /** Dotted path to the offending field, or "(body)" for a whole-body issue. */
  field: string;
  message: string;
}

/** Which page corner `y` is measured from. Default 'bottom-left' (PDF convention). */
export type StampOrigin = 'bottom-left' | 'top-left';

/** Unit of the stamp rectangle. Default 'pt' (PDF points, 1/72 inch). */
export type StampUnits = 'pt' | 'px';

/**
 * Where to draw the stamp.
 *
 * The default space is PDF points with the origin at the bottom-left of the
 * page. A rectangle measured in a browser is in neither — it is in pixels from
 * the top-left of a page rendered at some scale. Say so with `origin`, `units`
 * and `viewportWidth` instead of converting by hand; the server has the real
 * page dimensions and does it exactly.
 */
export interface StampPosition {
  /** Page index, 0-based. */
  page: number;
  /** Distance from the LEFT page edge, in `units`. */
  x: number;
  /** Distance from the edge named by `origin`, in `units`. */
  y: number;
  /** Stamp width, in `units`. */
  width: number;
  /** Stamp height, in `units`. */
  height: number;
  /**
   * Corner `y` is measured from. Default 'bottom-left'. Use 'top-left' for a
   * browser coordinate. Cannot be converted on a page whose `rotation` is not 0.
   */
  origin?: StampOrigin;
  /**
   * Unit of the rectangle. Default 'pt'. 'px' requires `viewportWidth` or
   * `viewportHeight`, and cannot be converted on a rotated page.
   */
  units?: StampUnits;
  /**
   * Pixel width of the rendered page the rectangle was measured against — e.g.
   * pdf.js `page.getViewport({ scale }).width`. Only valid with `units: 'px'`.
   */
  viewportWidth?: number;
  /**
   * Pixel height of the rendered page the rectangle was measured against.
   * Interchangeable with `viewportWidth`. Only valid with `units: 'px'`.
   */
  viewportHeight?: number;
}

/** The visual stamp. Provide exactly one of `svgString` or `text`. */
export interface SignatureAppearance {
  /** A complete SVG document. MUST contain a viewBox attribute. */
  svgString?: string;
  /** Text rendered in a script font. Mutually exclusive with `svgString`. */
  text?: string;
  /** Text mode only. Default 32. */
  fontSize?: number;
  /** CSS color for text mode. Default '#1a1a2e'. */
  color?: string;
  /** Rasterisation scale relative to the stamp size. Default 2. */
  renderScale?: number;
}

/** Values written into the PDF signature dictionary and the PKCS#7 signedAttrs. */
export interface SigningMetadata {
  reason?: string;
  location?: string;
  contactInfo?: string;
  signerName?: string;
  /** ISO 8601 string or a Date. Defaults to the server clock. */
  signingDate?: string | Date;
  /**
   * Size of the /Contents slot in bytes. Raise this after a SIGNATURE_OVERFLOW —
   * the error carries the size actually needed. Default 16384.
   */
  placeholderSizeBytes?: number;
  /** Use 'ETSI.CAdES.detached' for eIDAS/PAdES contexts. */
  subFilter?: 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached';
}

/** A PDF to upload: raw bytes, or anything the platform's FormData accepts. */
export type PdfInput = Uint8Array | ArrayBuffer | Blob;

export interface SignRequest {
  pdf: PdfInput;
  /** Filename sent with the upload part. Cosmetic; defaults to 'document.pdf'. */
  filename?: string;
  /** Omit both `appearance` and `position` for an invisible signature. */
  appearance?: SignatureAppearance;
  /** Required whenever `appearance` is given. */
  position?: StampPosition;
  metadata?: SigningMetadata;
}

/** The stamp rectangle actually drawn: PDF points, bottom-left origin. */
export interface ResolvedStampRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SignResult {
  /** The signed PDF bytes. */
  signedPdf: Uint8Array;
  /** Hex SHA-256 of the signed ByteRange segments. */
  documentHash: string;
  /** [offset1, length1, offset2, length2] — the byte spans the signature covers. */
  byteRange: [number, number, number, number];
  /** UTC ISO 8601 timestamp embedded in the signature. */
  signingTime: string;
  /**
   * Where the stamp landed, in PDF points with a bottom-left origin, after any
   * origin/units conversion. Absent when no stamp was requested. Worth asserting
   * against what your UI drew.
   */
  stampRect?: ResolvedStampRect;
}

/** Geometry of one page, from `inspect()`. */
export interface PdfPageInfo {
  /** 0-based index — the value to use as `StampPosition.page`. */
  index: number;
  /** Width in PDF points in user space. Stamp arithmetic uses this. */
  widthPts: number;
  /** Height in PDF points in user space. */
  heightPts: number;
  /** /Rotate normalised to 0, 90, 180 or 270. */
  rotation: number;
  /** Width of the box a viewer displays (axes swap when rotation is 90/270). */
  displayWidthPts: number;
  /** Height of the box a viewer displays. */
  displayHeightPts: number;
}

export interface InspectResult {
  sizeBytes: number;
  pageCount: number;
  pages: PdfPageInfo[];
  /** True when password-protected. Such a document cannot be signed. */
  encrypted: boolean;
  /** Signatures the document already carries. Non-zero means it was signed before. */
  signatureCount: number;
  /** Whether the document can be sent to `sign()` as-is. */
  signable: boolean;
}

export interface PdfSignerClientOptions {
  /** Base URL of the API, e.g. 'https://signer.internal'. A trailing slash is fine. */
  baseUrl: string;
  /** Value sent as the `x-api-key` header. */
  apiKey: string;
  /** Abort a request after this many milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Injectable fetch, for tests or a custom agent. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
}

/**
 * A non-2xx response from the API.
 *
 * Branch on `code` — it is a stable identifier — rather than on `message`, which
 * is human-readable and may change. `details` is populated for VALIDATION_ERROR,
 * and `actualBytes`/`allocatedBytes` for SIGNATURE_OVERFLOW.
 */
export class PdfSignerApiError extends Error {
  readonly code: ErrorCode | 'UNKNOWN';
  readonly status: number;
  readonly details?: ValidationIssue[];
  /** SIGNATURE_OVERFLOW only: size of the assembled PKCS#7 container. */
  readonly actualBytes?: number;
  /** SIGNATURE_OVERFLOW only: size of the placeholder it did not fit into. */
  readonly allocatedBytes?: number;

  constructor(
    message: string,
    status: number,
    code: ErrorCode | 'UNKNOWN',
    extra?: { details?: ValidationIssue[]; actualBytes?: number; allocatedBytes?: number },
  ) {
    super(message);
    this.name = 'PdfSignerApiError';
    this.status = status;
    this.code = code;
    this.details = extra?.details;
    this.actualBytes = extra?.actualBytes;
    this.allocatedBytes = extra?.allocatedBytes;
  }

  /**
   * The placeholder size to retry with after a SIGNATURE_OVERFLOW, or undefined
   * for any other error. The margin covers the DER length fields growing as the
   * container does.
   *
   * @example
   * ```typescript
   * try {
   *   return await client.sign(request);
   * } catch (err) {
   *   const retrySize = err instanceof PdfSignerApiError ? err.suggestedPlaceholderSize : undefined;
   *   if (!retrySize) throw err;
   *   return await client.sign({
   *     ...request,
   *     metadata: { ...request.metadata, placeholderSizeBytes: retrySize },
   *   });
   * }
   * ```
   */
  get suggestedPlaceholderSize(): number | undefined {
    if (this.code !== 'SIGNATURE_OVERFLOW' || this.actualBytes === undefined) return undefined;
    return this.actualBytes + 512;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class PdfSignerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: PdfSignerClientOptions) {
    if (!options.baseUrl) throw new Error('PdfSignerClient requires a baseUrl');
    if (!options.apiKey) throw new Error('PdfSignerClient requires an apiKey');

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const resolved = options.fetch ?? globalThis.fetch;
    if (typeof resolved !== 'function') {
      throw new Error(
        'No fetch implementation available. Node 18+ provides one globally; on older ' +
          'runtimes pass one via the `fetch` option.',
      );
    }
    // Bound so the global implementation is not called with `this` as the client.
    this.fetchImpl = resolved.bind(globalThis);
  }

  /**
   * Read a document's page geometry without modifying it.
   *
   * Call this before building a `position`: a stamp rectangle only means
   * anything relative to a page's dimensions. It is also where to reject an
   * upload — `encrypted` documents cannot be signed, and a non-zero
   * `signatureCount` means the file was signed already.
   */
  async inspect(pdf: PdfInput, filename = 'document.pdf'): Promise<InspectResult> {
    const form = new FormData();
    form.append('pdf', toBlob(pdf), filename);

    const response = await this.request('/api/v1/documents/inspect', form);
    return (await response.json()) as InspectResult;
  }

  /**
   * Stamp and cryptographically sign a PDF.
   *
   * `appearance` and `position` travel together: supplying one without the other
   * is rejected. Omit both for an invisible, cryptographic-only signature.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    if (request.appearance && !request.position) {
      throw new Error(
        'sign() requires `position` whenever `appearance` is given — the server cannot guess ' +
          'where to draw the stamp. Call inspect() for the page dimensions.',
      );
    }
    if (request.position && !request.appearance) {
      throw new Error(
        'sign() received `position` without `appearance`, so there is nothing to draw. Add an ' +
          'appearance, or drop the position for an invisible signature.',
      );
    }

    const form = new FormData();
    form.append('pdf', toBlob(request.pdf), request.filename ?? 'document.pdf');

    // Each of these parts is a STRING containing JSON — the server parses the
    // string, it does not accept a nested object part. Appending the object
    // directly would serialise as "[object Object]".
    if (request.metadata) form.append('metadata', JSON.stringify(normaliseMetadata(request.metadata)));
    if (request.appearance) form.append('appearance', JSON.stringify(request.appearance));
    if (request.position) form.append('position', JSON.stringify(request.position));

    const response = await this.request('/api/v1/sign', form);
    const signedPdf = new Uint8Array(await response.arrayBuffer());

    return {
      signedPdf,
      documentHash: response.headers.get('x-document-hash') ?? '',
      byteRange: parseJsonHeader<[number, number, number, number]>(response, 'x-byte-range') ?? [
        0, 0, 0, 0,
      ],
      signingTime: response.headers.get('x-signing-time') ?? '',
      stampRect: parseJsonHeader<ResolvedStampRect>(response, 'x-stamp-rect'),
    };
  }

  /** Liveness probe. Unauthenticated on the server, but sent with the key anyway. */
  async health(): Promise<{ status: string; service: string }> {
    const response = await this.request('/health');
    return (await response.json()) as { status: string; service: string };
  }

  /**
   * Issue a request and convert any non-2xx response into a PdfSignerApiError.
   *
   * The timeout is enforced here rather than left to the platform default so a
   * hung signing call surfaces as an error the caller can act on.
   */
  private async request(path: string, body?: FormData): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-api-key': this.apiKey },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request to ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw await toApiError(response);
    return response;
  }
}

/**
 * Build a PdfSignerApiError from an error response.
 *
 * The body is normally the server's `{ error, code }` envelope, but a proxy or
 * gateway in front of the service can return HTML or nothing at all — hence the
 * fallback, so a 502 from infrastructure still arrives as a usable error rather
 * than a JSON parse failure.
 */
async function toApiError(response: Response): Promise<PdfSignerApiError> {
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body; fall through to the generic message below.
  }

  const message =
    typeof payload.error === 'string'
      ? payload.error
      : `Request failed with HTTP ${response.status} ${response.statusText}`;
  const code = typeof payload.code === 'string' ? (payload.code as ErrorCode) : 'UNKNOWN';

  return new PdfSignerApiError(message, response.status, code, {
    details: Array.isArray(payload.details) ? (payload.details as ValidationIssue[]) : undefined,
    actualBytes: typeof payload.actualBytes === 'number' ? payload.actualBytes : undefined,
    allocatedBytes: typeof payload.allocatedBytes === 'number' ? payload.allocatedBytes : undefined,
  });
}

/** Accept a Date for `signingDate` while sending the ISO 8601 string the API expects. */
function normaliseMetadata(metadata: SigningMetadata): Record<string, unknown> {
  const { signingDate, ...rest } = metadata;
  if (signingDate === undefined) return rest;
  return {
    ...rest,
    signingDate: signingDate instanceof Date ? signingDate.toISOString() : signingDate,
  };
}

/** Wrap raw bytes so FormData sends them as a file part with a PDF content type. */
function toBlob(pdf: PdfInput): Blob {
  if (pdf instanceof Blob) return pdf;
  // Copy into a fresh Uint8Array rather than passing the input through: a Node
  // Buffer is a view onto a shared allocation pool, so handing it to Blob
  // directly can capture bytes belonging to unrelated buffers.
  const bytes = pdf instanceof ArrayBuffer ? new Uint8Array(pdf) : new Uint8Array(pdf);
  return new Blob([bytes], { type: 'application/pdf' });
}

/** Read a header whose value is JSON, tolerating its absence or a malformed value. */
function parseJsonHeader<T>(response: Response, header: string): T | undefined {
  const raw = response.headers.get(header);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
