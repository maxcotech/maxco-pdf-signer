// VERIFICATION: The first byte of buildPkcs7Local() output must be 0x30 (SEQUENCE).
// Pipe the extracted /Contents bytes through `openssl pkcs7 -inform DER -print_certs -noout`
// to verify the certificate chain. Verify that `openssl pkcs7 -inform DER` succeeds.
//
// THE CRITICAL TAG SWAP (RFC 5652 §5.4):
// The signedAttrs are DER-encoded with tag 0x31 (SET) for the signing/hashing operation.
// In the PKCS#7 container they are written with tag 0xA0 (context-specific constructed [0]).
// The RSA private-key operation MUST use the 0x31-tagged encoding.
// Using 0xA0 for signing causes Adobe to ALWAYS reject the signature.

import * as forge from 'node-forge';
import * as crypto from 'crypto';
import {
  TAG_SEQUENCE,
  TAG_SET,
  TAG_INTEGER,
  TAG_OID,
  TAG_OCTET_STRING,
  TAG_CONTEXT_0,
  TAG_CONTEXT_1,
  derWrap,
  encodeOid,
  encodeInteger,
  encodeIntegerValue,
  encodeUtcTime,
  encodeSha256AlgorithmIdentifier,
} from '../utils/asn1Utils';
import { getIssuerDer, getSerialNumberBuffer } from '../utils/certUtils';
import type { ParsedCertificateChain } from '../utils/certUtils';

// ─── OIDs (all cited to their defining RFC/spec) ─────────────────────────────

// RFC 5652 §3: OID for CMS SignedData content type
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
// RFC 5652 §5.2: OID for id-data (used in encapContentInfo for detached sigs)
const OID_DATA = '1.2.840.113549.1.7.1';
// RFC 5652 §11.1 (formerly RFC 2630 §11.1): content-type signed attribute
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
// RFC 5652 §11.2 (formerly RFC 2630 §11.2): message-digest signed attribute
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
// RFC 5652 §11.3 (formerly RFC 2630 §11.3): signing-time signed attribute
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
// RFC 3279 §2.3.1: rsaEncryption signature algorithm
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
// NIST FIPS 180-4 / RFC 5754 §2: SHA-256 digest algorithm
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the signed attributes structure for signing and container embedding.
 *
 * Returns two encodings:
 *  - signingForm (tag 0x31 SET): used as the input to the digest/signing operation
 *  - containerForm (tag 0xA0 [0] implicit): embedded in the PKCS#7 SignerInfo
 *
 * RFC 5652 §5.4: "The message digest calculation process computes a message digest
 * on the content together with the signed attributes... the complete DER encoding
 * of the signedAttrs value... with its IMPLICIT tag replaced by a SET OF tag."
 */
export function buildSignedAttributes(
  documentHash: Buffer,
  signingTime: Date,
): { containerForm: Buffer; signingForm: Buffer } {
  // Attribute 1: contentType — RFC 5652 §11.1
  // SEQUENCE { OID(contentType), SET { OID(id-data) } }
  const contentTypeAttr = derWrap(
    TAG_SEQUENCE,
    Buffer.concat([
      encodeOid(OID_CONTENT_TYPE),
      derWrap(TAG_SET, encodeOid(OID_DATA)),
    ]),
  );

  // Attribute 2: signingTime — RFC 5652 §11.3
  // SEQUENCE { OID(signingTime), SET { UTCTime } }
  const signingTimeAttr = derWrap(
    TAG_SEQUENCE,
    Buffer.concat([
      encodeOid(OID_SIGNING_TIME),
      derWrap(TAG_SET, encodeUtcTime(signingTime)),
    ]),
  );

  // Attribute 3: messageDigest — RFC 5652 §11.2
  // SEQUENCE { OID(messageDigest), SET { OCTET STRING(hash) } }
  const messageDigestAttr = derWrap(
    TAG_SEQUENCE,
    Buffer.concat([
      encodeOid(OID_MESSAGE_DIGEST),
      derWrap(TAG_SET, derWrap(TAG_OCTET_STRING, documentHash)),
    ]),
  );

  const attrsContent = Buffer.concat([contentTypeAttr, signingTimeAttr, messageDigestAttr]);

  // RFC 5652 §5.4 — THE CRITICAL TAG SWAP:
  // Build with 0x31 (SET) tag for the digest/signing operation.
  // Build with 0xA0 (context-specific [0]) tag for the container embedding.
  // Both share the SAME attrsContent — only the outer tag differs.
  const signingForm = derWrap(TAG_SET, attrsContent); // 0x31: used for RSA sign
  const containerForm = derWrap(TAG_CONTEXT_0, attrsContent); // 0xA0: stored in PKCS#7

  return { containerForm, signingForm };
}

/**
 * Build a complete PKCS#7/CMS detached SignedData container for LOCAL signing.
 *
 * Signs the signedAttrs (0x31-tagged) using the private key from ParsedCertificateChain.
 * The documentHash goes into the messageDigest signed attribute.
 *
 * RFC 5652 §5: SignedData structure built byte-by-byte using ASN.1 DER.
 * NO high-level forge .sign() calls — every field is explicitly constructed.
 *
 * @param documentHash - SHA-256(ByteRange bytes)
 * @param chain - Parsed P12 with signerCert + CA certs + private key
 * @param signingTime - Timestamp to embed in signingTime attribute
 * @returns Complete DER-encoded PKCS#7 ContentInfo buffer
 */
export function buildPkcs7Local(
  documentHash: Buffer,
  chain: ParsedCertificateChain,
  signingTime: Date,
): Buffer {
  if (!chain.privateKey) {
    throw new Error('ParsedCertificateChain must include a private key for local signing');
  }

  // Build signed attributes in both forms
  const { containerForm, signingForm } = buildSignedAttributes(documentHash, signingTime);

  // Sign the 0x31-tagged signedAttrs with the private key
  // forge.pki.rsa.PrivateKey.sign() accepts a MessageDigest and returns the signature bytes
  const md = forge.md.sha256.create();
  md.update(signingForm.toString('binary'));
  const rsaKey = chain.privateKey as forge.pki.rsa.PrivateKey;
  const signatureBytes = Buffer.from(rsaKey.sign(md), 'binary');

  return assemblePkcs7(
    documentHash,
    chain.signerCertDer,
    chain.signerCert,
    chain.caCertsDer,
    signatureBytes,
    containerForm,
    signingTime,
  );
}

/**
 * Build a PKCS#7/CMS detached SignedData container for REMOTE HSM signing.
 *
 * The caller has already invoked the HSM with the 0x31-tagged signedAttrs bytes
 * and received the raw RSA signature bytes. This function assembles the final container.
 *
 * @param documentHash - SHA-256(ByteRange bytes) — goes into messageDigest attribute
 * @param signerCertDer - DER-encoded signer certificate
 * @param signerCert - forge Certificate object (for IssuerAndSerialNumber)
 * @param caCertsDer - DER-encoded CA/intermediate certificates
 * @param hsmSignatureBytes - Raw signature bytes returned by the HSM
 * @param signingTime - Signing timestamp
 */
export function buildPkcs7Remote(
  documentHash: Buffer,
  signerCertDer: Buffer,
  signerCert: forge.pki.Certificate,
  caCertsDer: Buffer[],
  hsmSignatureBytes: Buffer,
  signingTime: Date,
): Buffer {
  const { containerForm } = buildSignedAttributes(documentHash, signingTime);

  return assemblePkcs7(
    documentHash,
    signerCertDer,
    signerCert,
    caCertsDer,
    hsmSignatureBytes,
    containerForm,
    signingTime,
  );
}

// ─── Internal assembly ────────────────────────────────────────────────────────

/**
 * Assemble the complete PKCS#7 ContentInfo → SignedData DER structure.
 *
 * RFC 5652 §5 defines the full SignedData structure:
 *
 * ContentInfo ::= SEQUENCE {
 *   contentType ContentType,         -- OID 1.2.840.113549.1.7.2
 *   content [0] EXPLICIT ANY         -- SignedData
 * }
 *
 * SignedData ::= SEQUENCE {
 *   version CMSVersion,              -- INTEGER 1
 *   digestAlgorithms SET,
 *   encapContentInfo EncapsulatedContentInfo,
 *   certificates [0] IMPLICIT OPTIONAL,
 *   signerInfos SET
 * }
 */
function assemblePkcs7(
  documentHash: Buffer,
  signerCertDer: Buffer,
  signerCert: forge.pki.Certificate,
  caCertsDer: Buffer[],
  signatureBytes: Buffer,
  containerFormAttrs: Buffer, // 0xA0-tagged signedAttrs
  signingTime: Date,
): Buffer {
  // ── digestAlgorithms SET { AlgorithmIdentifier(SHA-256) } ────────────────
  // RFC 5652 §5.1
  const digestAlgorithms = derWrap(TAG_SET, encodeSha256AlgorithmIdentifier());

  // ── encapContentInfo ─────────────────────────────────────────────────────
  // RFC 5652 §5.2: detached signature — eContent is ABSENT
  const encapContentInfo = derWrap(
    TAG_SEQUENCE,
    encodeOid(OID_DATA), // eContentType only; no eContent for detached
  );

  // ── certificates [0] IMPLICIT ────────────────────────────────────────────
  // RFC 5652 §5.1: [0] IMPLICIT wraps all certificates in the chain
  const allCertsDer = Buffer.concat([signerCertDer, ...caCertsDer]);
  const certificates = derWrap(TAG_CONTEXT_0, allCertsDer);

  // ── SignerInfo ────────────────────────────────────────────────────────────
  // RFC 5652 §5.3
  const signerInfo = buildSignerInfo(
    signerCert,
    containerFormAttrs,
    signatureBytes,
  );

  // ── signerInfos SET ───────────────────────────────────────────────────────
  const signerInfos = derWrap(TAG_SET, signerInfo);

  // ── SignedData SEQUENCE ───────────────────────────────────────────────────
  // RFC 5652 §5.1: version=1 for SignerInfo using IssuerAndSerialNumber
  const signedDataContent = Buffer.concat([
    encodeIntegerValue(1), // version INTEGER 1
    digestAlgorithms,
    encapContentInfo,
    certificates,
    signerInfos,
  ]);
  const signedData = derWrap(TAG_SEQUENCE, signedDataContent);

  // ── ContentInfo ───────────────────────────────────────────────────────────
  // RFC 5652 §3: ContentInfo wraps SignedData with OID + [0] EXPLICIT
  const contentInfoContent = Buffer.concat([
    encodeOid(OID_SIGNED_DATA),
    derWrap(TAG_CONTEXT_0, signedData), // [0] EXPLICIT
  ]);
  const contentInfo = derWrap(TAG_SEQUENCE, contentInfoContent);

  return contentInfo;
}

/**
 * Build the SignerInfo SEQUENCE for a single signer.
 *
 * RFC 5652 §5.3:
 * SignerInfo ::= SEQUENCE {
 *   version CMSVersion,
 *   sid SignerIdentifier,           -- IssuerAndSerialNumber
 *   digestAlgorithm AlgorithmIdentifier,
 *   signedAttrs [0] IMPLICIT OPTIONAL,
 *   signatureAlgorithm AlgorithmIdentifier,
 *   signature SignatureValue,
 * }
 */
function buildSignerInfo(
  signerCert: forge.pki.Certificate,
  containerFormAttrs: Buffer, // [0] IMPLICIT (0xA0) tagged
  signatureBytes: Buffer,
): Buffer {
  // version INTEGER 1 (IssuerAndSerialNumber form)
  const version = encodeIntegerValue(1);

  // sid: IssuerAndSerialNumber ::= SEQUENCE { issuer Name, serialNumber CertificateSerialNumber }
  const issuerDer = getIssuerDer(signerCert);
  const serialDer = encodeInteger(getSerialNumberBuffer(signerCert));
  const sid = derWrap(TAG_SEQUENCE, Buffer.concat([issuerDer, serialDer]));

  // digestAlgorithm: SHA-256 (OID 2.16.840.1.101.3.4.2.1)
  const digestAlgorithm = encodeSha256AlgorithmIdentifier();

  // signedAttrs: already 0xA0-tagged (containerForm)
  // This is the critical tag — it must be 0xA0 in the container
  const signedAttrs = containerFormAttrs;

  // signatureAlgorithm: rsaEncryption (OID 1.2.840.113549.1.1.1)
  // RFC 3279 §2.3.1
  const signatureAlgorithm = buildAlgorithmIdentifierNoParams(OID_RSA_ENCRYPTION);

  // signature: OCTET STRING
  const signature = derWrap(TAG_OCTET_STRING, signatureBytes);

  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([version, sid, digestAlgorithm, signedAttrs, signatureAlgorithm, signature]),
  );
}

/**
 * Build AlgorithmIdentifier with NO parameters (rsaEncryption conventionally omits NULL).
 * RFC 3279 §2.3.1: "When the rsaEncryption OID is used, the parameters MUST employ
 * the RSASSA-PKCS1-v1_5 algorithm. The parameters field MUST have ASN.1 type NULL."
 *
 * We include NULL for maximum compatibility with Adobe.
 */
function buildAlgorithmIdentifierNoParams(oidStr: string): Buffer {
  // AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters NULL }
  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([encodeOid(oidStr), Buffer.from([0x05, 0x00])]), // NULL
  );
}
