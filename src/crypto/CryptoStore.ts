// VERIFICATION: After signWithLocalCertificate() or signWithRemoteHsm():
//   1. verifyByteRangeIntegrity() must return valid: true
//   2. The documentHash in SignedPdfResult must match SHA-256(ByteRange bytes) independently
//   3. openssl pkcs7 -inform DER -in <(xxd -r -p <<< "$pkcs7Hex") must succeed

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as forge from 'node-forge';
import { PdfEngine } from '../engine/PdfEngine';
import { buildPkcs7Local, buildPkcs7Remote, buildSignedAttributes } from './pkcs7Builder';
import { parseP12, parsePemCertificate, parseDerCertificate, parsePemCertificates } from '../utils/certUtils';
import { HsmTimeoutError, InvalidCertificateError, PdfSignerError } from '../errors';
import type { LocalSigningOptions, RemoteHsmSigningOptions, SigningMetadata, SignedPdfResult } from './CryptoStore.types';

export class CryptoStore {
  private readonly pdfEngine: PdfEngine;

  constructor() {
    this.pdfEngine = new PdfEngine();
  }

  /**
   * Sign a PDF buffer using a local PKCS#12 certificate.
   *
   * Sequence:
   *   1. Parse P12 bundle → signer cert + CA chain + private key
   *   2. Prepare PDF: inject AcroForm/widget + Sig dict placeholder, compute ByteRange
   *   3. Extract ByteRange bytes (includes visual stamp if stamped before this call)
   *   4. SHA-256(ByteRange bytes) → documentHash → messageDigest signed attribute
   *   5. Build PKCS#7 DER: signed attributes → RSA sign with private key → assemble container
   *   6. Inject PKCS#7 hex into /Contents slot
   *
   * @throws InvalidCertificateError on bad P12 password or missing key
   * @throws ByteRangeError if invariant fails
   * @throws SignatureOverflowError if PKCS#7 exceeds placeholder
   */
  async signWithLocalCertificate(
    pdfBuffer: Buffer,
    localOpts: LocalSigningOptions,
    metadata?: SigningMetadata,
  ): Promise<SignedPdfResult> {
    // Step 1: Load P12 material
    let p12Buffer: Buffer;
    if (localOpts.p12Buffer) {
      p12Buffer = localOpts.p12Buffer;
    } else if (localOpts.p12Path) {
      try {
        p12Buffer = fs.readFileSync(localOpts.p12Path);
      } catch (err) {
        throw new InvalidCertificateError(`Cannot read P12 file: ${String(err)}`);
      }
    } else {
      throw new InvalidCertificateError('Either p12Path or p12Buffer must be provided');
    }

    const chain = parseP12(p12Buffer, localOpts.p12Password);
    if (!chain.privateKey) {
      throw new InvalidCertificateError('P12 bundle does not contain a private key');
    }

    const signingTime = metadata?.signingDate ?? new Date();

    // Step 2: Prepare PDF with placeholder
    const prepared = await this.pdfEngine.preparePdfForSigning(pdfBuffer, {
      placeholderSize: metadata?.placeholderSizeBytes ?? 16384,
      reason: metadata?.reason,
      location: metadata?.location,
      contactInfo: metadata?.contactInfo,
      name: metadata?.signerName,
      signingDate: signingTime,
      subFilter: metadata?.subFilter,
    });

    // Step 3: Extract bytes covered by ByteRange
    // The visual stamp image bytes are included here if it was stamped before this call.
    // Any modification to ANY of these bytes — including the stamp PNG — invalidates the sig.
    const signableBytes = this.pdfEngine.extractSignableBytes(prepared);

    // Step 4: SHA-256(ByteRange bytes) → goes into messageDigest signed attribute
    const documentHash = crypto.createHash('sha256').update(signableBytes).digest();

    // Step 5: Build PKCS#7 container — all crypto done in-process with private key
    const pkcs7Der = buildPkcs7Local(documentHash, chain, signingTime);
    const pkcs7Hex = pkcs7Der.toString('hex');

    // Step 6: Inject hex into /Contents placeholder slot (in-place buffer write)
    const signedPdfBuffer = this.pdfEngine.injectSignature(prepared, pkcs7Hex);

    return {
      signedPdf: signedPdfBuffer,
      documentHash: documentHash.toString('hex'),
      pkcs7Hex,
      byteRange: [
        prepared.byteRange.offset1,
        prepared.byteRange.length1,
        prepared.byteRange.offset2,
        prepared.byteRange.length2,
      ],
      signingTime: signingTime.toISOString(),
    };
  }

  /**
   * Sign a PDF buffer using an external Cloud HSM/KMS.
   *
   * Decouples hash computation from signing:
   *   - Library: computes ByteRange bytes → SHA-256 → builds SignedAttributes (0x31 SET form)
   *   - HSM:     receives SignedAttributes bytes → performs private-key operation → returns bytes
   *   - Library: assembles complete PKCS#7 container → injects into /Contents
   *
   * The hsmSignFunction receives the 0x31 SET-tagged SignedAttributes DER.
   * The function MUST return raw RSA-PKCS1v15 or ECDSA signature bytes.
   *
   * Platform notes (see CryptoStore.types.ts for per-platform hashing responsibility):
   *   - AWS KMS MessageType:'DIGEST' → pre-hash inside hsmSignFunction
   *   - Azure Key Vault RS256 → pass raw bytes (Azure hashes internally)
   *   - GCP Cloud KMS → pass raw bytes (GCP hashes internally)
   *
   * @throws HsmTimeoutError if the HSM callback does not resolve within the configured timeout
   */
  async signWithRemoteHsm(
    pdfBuffer: Buffer,
    hsmOpts: RemoteHsmSigningOptions,
    metadata?: SigningMetadata,
    hsmTimeoutMs = 30000,
  ): Promise<SignedPdfResult> {
    const signingTime = metadata?.signingDate ?? new Date();

    // Resolve signer certificate
    const { signerCertDer, signerCert, caCertsDer } = this.resolveHsmCertificates(hsmOpts);

    // Step 1: Inject placeholder, fix ByteRange in buffer
    const prepared = await this.pdfEngine.preparePdfForSigning(pdfBuffer, {
      placeholderSize: metadata?.placeholderSizeBytes ?? 16384,
      reason: metadata?.reason,
      location: metadata?.location,
      contactInfo: metadata?.contactInfo,
      name: metadata?.signerName,
      signingDate: signingTime,
      subFilter: metadata?.subFilter,
    });

    // Step 2: Extract bytes covered by ByteRange — these define what was signed.
    // The visual stamp image bytes are included here (it was stamped before this call).
    const signableBytes = this.pdfEngine.extractSignableBytes(prepared);

    // Step 3: SHA-256(ByteRange bytes) → goes into messageDigest signed attribute
    const documentHash = crypto.createHash('sha256').update(signableBytes).digest();

    // Step 4: Build SignedAttributes.
    // signingForm (0x31) goes to HSM — this is what the HSM signs.
    // containerForm (0xA0) goes in PKCS#7 container.
    const { signingForm } = buildSignedAttributes(documentHash, signingTime);

    // Step 5: Call HSM with raw signedAttrs bytes (0x31-tagged DER).
    // Apply a 30-second timeout — wrap in Promise.race with a rejection timer.
    const signatureBytes = await this.callHsmWithTimeout(
      hsmOpts.hsmSignFunction,
      signingForm,
      hsmTimeoutMs,
    );

    // Step 6: Assemble PKCS#7 container using the externally-produced signature bytes
    const pkcs7Der = buildPkcs7Remote(
      documentHash,
      signerCertDer,
      signerCert,
      caCertsDer,
      signatureBytes,
      signingTime,
    );

    // Step 7: Inject hex into the /Contents placeholder slot (in-place buffer write)
    const pkcs7Hex = pkcs7Der.toString('hex');
    const signedPdfBuffer = this.pdfEngine.injectSignature(prepared, pkcs7Hex);

    return {
      signedPdf: signedPdfBuffer,
      documentHash: documentHash.toString('hex'),
      pkcs7Hex,
      byteRange: [
        prepared.byteRange.offset1,
        prepared.byteRange.length1,
        prepared.byteRange.offset2,
        prepared.byteRange.length2,
      ],
      signingTime: signingTime.toISOString(),
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private resolveHsmCertificates(hsmOpts: RemoteHsmSigningOptions): {
    signerCertDer: Buffer;
    signerCert: forge.pki.Certificate;
    caCertsDer: Buffer[];
  } {
    // Resolve signer certificate
    let signerCertDer: Buffer;
    let signerCert: forge.pki.Certificate;

    if (typeof hsmOpts.signerCertificate === 'string') {
      signerCert = parsePemCertificate(hsmOpts.signerCertificate);
      signerCertDer = Buffer.from(
        forge.asn1.toDer(forge.pki.certificateToAsn1(signerCert)).getBytes(),
        'binary',
      );
    } else {
      signerCertDer = hsmOpts.signerCertificate;
      signerCert = parseDerCertificate(signerCertDer);
    }

    // Resolve intermediate/CA certificates
    const caCertsDer: Buffer[] = [];
    if (hsmOpts.intermediateCerts) {
      for (const cert of hsmOpts.intermediateCerts) {
        if (typeof cert === 'string') {
          // PEM — may be a multi-cert bundle
          const ders = parsePemCertificates(cert);
          caCertsDer.push(...ders);
        } else {
          caCertsDer.push(cert);
        }
      }
    }

    return { signerCertDer, signerCert, caCertsDer };
  }

  private async callHsmWithTimeout(
    hsmSignFunction: (bytes: Buffer) => Promise<Buffer>,
    signingForm: Buffer,
    timeoutMs: number,
  ): Promise<Buffer> {
    let timeoutHandle: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new HsmTimeoutError(timeoutMs));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        hsmSignFunction(signingForm),
        timeoutPromise,
      ]);
      clearTimeout(timeoutHandle!);
      return result;
    } catch (err) {
      clearTimeout(timeoutHandle!);
      if (err instanceof HsmTimeoutError) throw err;
      if (err instanceof PdfSignerError) throw err;
      throw new PdfSignerError(
        `HSM signing callback threw an error: ${String(err)}`,
        'HSM_ERROR',
      );
    }
  }
}
