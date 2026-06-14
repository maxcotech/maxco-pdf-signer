/**
 * PdfSigner — Primary public API.
 *
 * Enforces the mandatory execution order: visual stamp FIRST, then cryptographic seal.
 * This ordering guarantees the stamp pixels are covered by the cryptographic hash —
 * any post-signing modification to the stamp is detectable.
 *
 * @example SVG stamp + local P12
 * ```typescript
 * import { PdfSigner } from 'pdf-signer';
 * import fs from 'fs';
 *
 * const signer = new PdfSigner();
 * const result = await signer.signLocal({
 *   pdfBuffer: fs.readFileSync('contract.pdf'),
 *   p12Path: './cert.p12',
 *   p12Password: 'secret',
 *   appearance: {
 *     svgString: fs.readFileSync('sig.svg', 'utf8'),
 *   },
 *   position: { page: 0, x: 50, y: 40, width: 200, height: 60 },
 *   reason: 'Approved',
 *   location: 'New York, USA',
 * });
 * fs.writeFileSync('signed.pdf', result.signedPdf);
 * ```
 *
 * @example Text stamp + remote HSM
 * ```typescript
 * const result = await signer.signRemote({
 *   pdfBuffer: fs.readFileSync('contract.pdf'),
 *   signerCertPem: fs.readFileSync('cert.pem', 'utf8'),
 *   hsmSignFunction: async (data) => await myKms.sign(data),
 *   appearance: { text: 'Jane Smith', fontSize: 36, color: '#1a3a6e' },
 *   position: { page: 2, x: 100, y: 80, width: 220, height: 70 },
 * });
 * ```
 */

import { VisualStamper } from './visual/VisualStamper';
import { CryptoStore } from './crypto/CryptoStore';
import { MissingPositionError } from './errors';
import type { SignatureAppearance, StampPosition } from './visual/VisualStamper.types';
import type { SigningMetadata, SignedPdfResult } from './crypto/CryptoStore.types';

export interface PdfSignerConstructorOptions {
  defaultPlaceholderSize?: number; // default 16384 bytes
  hsmTimeoutMs?: number; // default 30000 ms
}

export interface LocalSignOptions extends SigningMetadata {
  pdfBuffer: Buffer;
  p12Path?: string;
  p12Buffer?: Buffer;
  p12Password: string;
  appearance?: SignatureAppearance;
  position?: StampPosition;
}

export interface RemoteSignOptions extends SigningMetadata {
  pdfBuffer: Buffer;
  signerCertPem?: string;
  signerCertDer?: Buffer;
  intermediateCerts?: (string | Buffer)[];
  hsmSignFunction: (signedAttrsBytes: Buffer) => Promise<Buffer>;
  appearance?: SignatureAppearance;
  position?: StampPosition;
}

export interface VerificationResult {
  valid: boolean;
  details: {
    fileSize: number;
    byteRange: [number, number, number, number];
    segment1Covers: string;
    segment2Covers: string;
    contentsSlotSize: number;
    errors: string[];
  };
}

export class PdfSigner {
  private readonly visualStamper: VisualStamper;
  private readonly cryptoStore: CryptoStore;
  private readonly defaultPlaceholderSize: number;
  private readonly hsmTimeoutMs: number;

  constructor(options?: PdfSignerConstructorOptions) {
    this.visualStamper = new VisualStamper();
    this.cryptoStore = new CryptoStore();
    this.defaultPlaceholderSize = options?.defaultPlaceholderSize ?? 16384;
    this.hsmTimeoutMs = options?.hsmTimeoutMs ?? 30000;
  }

  /**
   * Apply visual stamp then sign with local P12.
   *
   * Execution order (must not be reversed):
   *   1. VisualStamper.applyStamp() — embeds PNG into PDF, serialises
   *   2. CryptoStore.signWithLocalCertificate() — hashes ByteRange, builds PKCS#7, injects
   *
   * If appearance is omitted, only the cryptographic signature is applied (no stamp).
   * If appearance is provided, position is required.
   *
   * @throws MissingPositionError if appearance provided without position
   * @throws InvalidAppearanceError if SVG/text is malformed
   * @throws InvalidCertificateError if P12 password is wrong or key is missing
   * @throws ByteRangeError if PDF structure cannot be prepared
   * @throws SignatureOverflowError if PKCS#7 exceeds placeholder size
   */
  async signLocal(options: LocalSignOptions): Promise<SignedPdfResult> {
    let pdfToSign = options.pdfBuffer;

    // Phase 1: Visual stamping — MUST happen before Phase 2.
    // The stamp is baked into the PDF bytes. Phase 2 hashes those bytes.
    // Reversing this order means the stamp is not covered by the cryptographic hash —
    // Adobe would report the document as "modified after signing."
    if (options.appearance) {
      if (!options.position) throw new MissingPositionError();
      const { stampedPdfBuffer } = await this.visualStamper.applyStamp(
        pdfToSign,
        options.appearance,
        options.position,
      );
      pdfToSign = stampedPdfBuffer;
    }

    // Phase 2: Cryptographic sealing
    return this.cryptoStore.signWithLocalCertificate(
      pdfToSign,
      {
        p12Path: options.p12Path,
        p12Buffer: options.p12Buffer,
        p12Password: options.p12Password,
      },
      {
        reason: options.reason,
        location: options.location,
        contactInfo: options.contactInfo,
        signerName: options.signerName,
        signingDate: options.signingDate,
        placeholderSizeBytes: options.placeholderSizeBytes ?? this.defaultPlaceholderSize,
        subFilter: options.subFilter,
      },
    );
  }

  /**
   * Apply visual stamp then sign with remote HSM.
   *
   * Same stamp-first ordering as signLocal. The hsmSignFunction receives the
   * 0x31 SET-tagged SignedAttributes DER and must return raw signature bytes.
   *
   * @throws MissingPositionError if appearance provided without position
   * @throws HsmTimeoutError if the HSM callback exceeds the configured timeout
   * @throws ByteRangeError if PDF structure cannot be prepared
   * @throws SignatureOverflowError if PKCS#7 exceeds placeholder size
   */
  async signRemote(options: RemoteSignOptions): Promise<SignedPdfResult> {
    let pdfToSign = options.pdfBuffer;

    // Phase 1: Visual stamping — MUST happen before Phase 2 (same reasoning as signLocal)
    if (options.appearance) {
      if (!options.position) throw new MissingPositionError();
      const { stampedPdfBuffer } = await this.visualStamper.applyStamp(
        pdfToSign,
        options.appearance,
        options.position,
      );
      pdfToSign = stampedPdfBuffer;
    }

    // Normalise cert inputs
    const signerCertificate: Buffer | string =
      options.signerCertDer ?? options.signerCertPem ?? (() => {
        throw new Error('signerCertPem or signerCertDer must be provided for remote signing');
      })();

    // Phase 2: Cryptographic sealing via HSM
    return this.cryptoStore.signWithRemoteHsm(
      pdfToSign,
      {
        signerCertificate,
        intermediateCerts: options.intermediateCerts,
        hsmSignFunction: options.hsmSignFunction,
      },
      {
        reason: options.reason,
        location: options.location,
        contactInfo: options.contactInfo,
        signerName: options.signerName,
        signingDate: options.signingDate,
        placeholderSizeBytes: options.placeholderSizeBytes ?? this.defaultPlaceholderSize,
        subFilter: options.subFilter,
      },
      this.hsmTimeoutMs,
    );
  }

  /**
   * Check that a signed PDF's ByteRange arithmetic is internally consistent.
   *
   * Verifies:
   *   - /ByteRange is present and parseable
   *   - length1 + 1 + contentsSlotSize + 1 + length2 === fileSize
   *   - offset2 > length1
   *   - length2 > 0
   *
   * Does NOT verify the cryptographic signature itself (requires a trust store).
   * Use Adobe Acrobat Reader or openssl pkcs7 for full cryptographic verification.
   */
  async verifyByteRangeIntegrity(signedPdfBuffer: Buffer): Promise<VerificationResult> {
    const errors: string[] = [];
    const str = signedPdfBuffer.toString('latin1');

    // Find /ByteRange
    const brMatch = str.match(/\/ByteRange\s+\[(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\]/);
    if (!brMatch) {
      return {
        valid: false,
        details: {
          fileSize: signedPdfBuffer.length,
          byteRange: [0, 0, 0, 0],
          segment1Covers: 'unknown',
          segment2Covers: 'unknown',
          contentsSlotSize: 0,
          errors: ['Could not find /ByteRange in signed PDF'],
        },
      };
    }

    const [, o1s, l1s, o2s, l2s] = brMatch;
    const offset1 = parseInt(o1s, 10);
    const length1 = parseInt(l1s, 10);
    const offset2 = parseInt(o2s, 10);
    const length2 = parseInt(l2s, 10);

    // Find /Contents hex size
    const contentsMatch = str.match(/\/Contents\s+<([0-9a-fA-F]*)>/);
    const contentsSlotSize = contentsMatch ? contentsMatch[1].length : 0;

    // Invariant: length1 + 1('<') + contentsSlotSize + 1('>') + length2 = fileSize
    const expected = length1 + 1 + contentsSlotSize + 1 + length2;
    if (expected !== signedPdfBuffer.length) {
      errors.push(
        `ByteRange invariant violated: ${length1}+1+${contentsSlotSize}+1+${length2}=${expected} ` +
          `!== fileSize ${signedPdfBuffer.length}`,
      );
    }

    if (offset1 !== 0) errors.push(`offset1 should be 0, got ${offset1}`);
    if (offset2 <= length1) errors.push(`offset2 (${offset2}) must be > length1 (${length1})`);
    if (length2 <= 0) errors.push(`length2 must be > 0, got ${length2}`);

    return {
      valid: errors.length === 0,
      details: {
        fileSize: signedPdfBuffer.length,
        byteRange: [offset1, length1, offset2, length2],
        segment1Covers: `bytes 0–${length1 - 1}`,
        segment2Covers: `bytes ${offset2}–${offset2 + length2 - 1}`,
        contentsSlotSize,
        errors,
      },
    };
  }
}

// Re-export SignedPdfResult so callers don't need to import from CryptoStore.types
export type { SignedPdfResult, SigningMetadata };
