// VERIFICATION: Every public method in the library should throw only from this hierarchy.

export class PdfSignerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** PKCS#7 container exceeds /Contents placeholder */
export class SignatureOverflowError extends PdfSignerError {
  constructor(public readonly actualBytes: number, public readonly allocatedBytes: number) {
    super(
      `PKCS#7 (${actualBytes} bytes) exceeds placeholder (${allocatedBytes} bytes). ` +
        `Set placeholderSizeBytes >= ${actualBytes + 512}.`,
      'SIGNATURE_OVERFLOW',
    );
  }
}

export class ByteRangeError extends PdfSignerError {
  constructor(detail: string) {
    super(`ByteRange error: ${detail}`, 'BYTE_RANGE_ERROR');
  }
}

export class InvalidCertificateError extends PdfSignerError {
  constructor(detail: string) {
    super(`Certificate error: ${detail}`, 'INVALID_CERTIFICATE');
  }
}

export class InvalidPdfError extends PdfSignerError {
  constructor(detail: string) {
    super(`Invalid PDF: ${detail}`, 'INVALID_PDF');
  }
}

export class InvalidAppearanceError extends PdfSignerError {
  constructor(detail: string) {
    super(`Invalid appearance: ${detail}`, 'INVALID_APPEARANCE');
  }
}

export class InvalidPositionError extends PdfSignerError {
  constructor(detail: string) {
    super(`Invalid position: ${detail}`, 'INVALID_POSITION');
  }
}

/** appearance provided without position */
export class MissingPositionError extends PdfSignerError {
  constructor() {
    super('position is required when appearance is specified.', 'MISSING_POSITION');
  }
}

/** HSM callback did not resolve within timeout */
export class HsmTimeoutError extends PdfSignerError {
  constructor(timeoutMs: number) {
    super(`HSM signing timed out after ${timeoutMs}ms.`, 'HSM_TIMEOUT');
  }
}
