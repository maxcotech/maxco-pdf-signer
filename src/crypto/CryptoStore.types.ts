export interface LocalSigningOptions {
  p12Path?: string;
  p12Buffer?: Buffer;
  p12Password: string;
}

export interface RemoteHsmSigningOptions {
  /**
   * The signer certificate (PEM string or DER Buffer).
   * The private key stays in the HSM and never appears here.
   */
  signerCertificate: Buffer | string;
  intermediateCerts?: (Buffer | string)[];
  /**
   * Async HSM callback. Receives DER SignedAttributes with 0x31 (SET) tag.
   * Must return raw RSA-PKCS1v15 or ECDSA signature bytes.
   *
   * Internal hashing responsibility by platform:
   * - Node.js crypto.createSign('SHA256'): hashes internally — pass raw bytes
   * - AWS KMS MessageType:'DIGEST': requires pre-hashed SHA-256 — caller must hash
   * - Azure Key Vault RS256: hashes internally — pass raw bytes
   * - GCP Cloud KMS SHA256_RSA_PKCS1: hashes internally — pass raw bytes
   */
  hsmSignFunction: (signedAttrsBytes: Buffer) => Promise<Buffer>;
}

export interface SigningMetadata {
  reason?: string;
  location?: string;
  contactInfo?: string;
  signerName?: string;
  signingDate?: Date;
  placeholderSizeBytes?: number; // default 16384
  subFilter?: 'adbe.pkcs7.detached' | 'ETSI.CAdES.detached';
}

export interface SignedPdfResult {
  signedPdf: Buffer;
  documentHash: string; // hex SHA-256 of ByteRange bytes
  pkcs7Hex: string; // hex-encoded PKCS#7 DER
  byteRange: [number, number, number, number];
  signingTime: string; // UTC ISO 8601
}
