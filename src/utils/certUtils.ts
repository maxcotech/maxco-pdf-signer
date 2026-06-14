// VERIFICATION: parseP12 throws InvalidCertificateError on MAC mismatch (wrong password).
// RFC 7292: PKCS#12 bags are unordered; chain is sorted by Subject→Issuer after parsing.

import * as forge from 'node-forge';
import { InvalidCertificateError } from '../errors';

export interface ParsedCertificateChain {
  signerCertDer: Buffer;
  signerCert: forge.pki.Certificate;
  /** Sorted: index 0 = direct issuer of signer, last = root CA */
  caCertsDer: Buffer[];
  privateKey?: forge.pki.PrivateKey;
}

/**
 * Parse a PKCS#12 (.p12/.pfx) bundle and extract the signing certificate, CA chain,
 * and private key.
 *
 * RFC 7292: bags are unordered; we sort the chain by matching Subject→Issuer after parsing.
 *
 * @throws InvalidCertificateError on MAC mismatch (wrong password) or malformed data
 */
export function parseP12(p12Buffer: Buffer, password: string): ParsedCertificateChain {
  let p12Asn1: forge.asn1.Asn1;
  try {
    p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer.toString('binary')));
  } catch (err) {
    throw new InvalidCertificateError(`Failed to parse PKCS#12 DER: ${String(err)}`);
  }

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
  } catch (err) {
    throw new InvalidCertificateError(
      `PKCS#12 MAC verification failed (wrong password or corrupt file): ${String(err)}`,
    );
  }

  // Extract all certificate bags
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const allCertBags = certBags[forge.pki.oids.certBag] ?? [];

  // Extract all key bags (shrouded or plain)
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const shroudedKeys = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const plainKeyBags = p12.getBags({ bagType: forge.pki.oids.keyBag });
  const plainKeys = plainKeyBags[forge.pki.oids.keyBag] ?? [];
  const allKeyBags = [...shroudedKeys, ...plainKeys];

  if (allCertBags.length === 0) {
    throw new InvalidCertificateError('PKCS#12 contains no certificate bags');
  }

  const certs = allCertBags.map((bag) => bag.cert!).filter(Boolean);

  if (certs.length === 0) {
    throw new InvalidCertificateError('PKCS#12 bags contained no valid certificates');
  }

  // Sort chain: find the signer cert (the one that has a matching private key,
  // or the leaf cert — leaf = not an issuer for any other cert in the set)
  const subjectMap = new Map<string, forge.pki.Certificate>();
  for (const cert of certs) {
    subjectMap.set(getSubjectStr(cert), cert);
  }

  // A leaf cert is one whose subject is not the issuer of any other cert
  const issuerStrs = new Set(certs.map(getIssuerStr));
  let signerCert: forge.pki.Certificate | undefined;

  for (const cert of certs) {
    if (!issuerStrs.has(getSubjectStr(cert))) {
      signerCert = cert;
      break;
    }
  }

  // Fallback: use the cert that has a private key, or the first cert
  if (!signerCert && allKeyBags.length > 0) {
    signerCert = certs[0];
  }
  if (!signerCert) {
    signerCert = certs[0];
  }

  // Sort the CA chain: starting from signerCert's issuer, walk up
  const caCerts: forge.pki.Certificate[] = [];
  let current = signerCert;
  const seen = new Set<string>();
  seen.add(getSubjectStr(signerCert));

  while (true) {
    const issuerStr = getIssuerStr(current);
    if (seen.has(issuerStr)) break; // self-signed or loop
    const issuerCert = subjectMap.get(issuerStr);
    if (!issuerCert) break; // issuer not in bundle
    caCerts.push(issuerCert);
    seen.add(issuerStr);
    current = issuerCert;
  }

  const signerCertDer = certToDer(signerCert);
  const caCertsDer = caCerts.map(certToDer);
  const privateKey = allKeyBags[0]?.key ?? undefined;

  return { signerCertDer, signerCert, caCertsDer, privateKey };
}

/**
 * Parse one or more PEM-encoded certificates (handles concatenated bundles).
 *
 * @returns Array of DER-encoded certificate Buffers
 */
export function parsePemCertificates(pem: string): Buffer[] {
  const results: Buffer[] = [];
  // Match all certificate blocks in the PEM string
  const regex = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pem)) !== null) {
    try {
      const cert = forge.pki.certificateFromPem(match[0]);
      results.push(certToDer(cert));
    } catch (err) {
      throw new InvalidCertificateError(`Failed to parse PEM certificate: ${String(err)}`);
    }
  }
  if (results.length === 0) {
    throw new InvalidCertificateError('No valid PEM certificates found in input');
  }
  return results;
}

/**
 * Parse a single PEM certificate and return a forge Certificate object.
 */
export function parsePemCertificate(pem: string): forge.pki.Certificate {
  try {
    return forge.pki.certificateFromPem(pem);
  } catch (err) {
    throw new InvalidCertificateError(`Failed to parse PEM certificate: ${String(err)}`);
  }
}

/**
 * Parse a DER-encoded certificate and return a forge Certificate object.
 */
export function parseDerCertificate(der: Buffer): forge.pki.Certificate {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary')));
    return forge.pki.certificateFromAsn1(asn1);
  } catch (err) {
    throw new InvalidCertificateError(`Failed to parse DER certificate: ${String(err)}`);
  }
}

/**
 * Get the Subject Key Identifier extension value from a certificate, if present.
 */
export function getSubjectKeyIdentifier(cert: forge.pki.Certificate): Buffer | undefined {
  const ext = cert.getExtension('subjectKeyIdentifier');
  if (!ext) return undefined;
  // forge returns the raw value; decode if it's a hex string
  const extObj = ext as { value?: string };
  if (typeof extObj.value === 'string') {
    return Buffer.from(extObj.value, 'binary');
  }
  return undefined;
}

/**
 * Extract the DER-encoded Issuer Name from a certificate.
 * Used to build IssuerAndSerialNumber in CMS SignerInfo (RFC 5652 §10.2.4).
 */
export function getIssuerDer(cert: forge.pki.Certificate): Buffer {
  const certAsn1 = forge.pki.certificateToAsn1(cert);
  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
  const tbs = (certAsn1 as forge.asn1.Asn1 & { value: forge.asn1.Asn1[] }).value[0];
  const tbsValues = (tbs as forge.asn1.Asn1 & { value: forge.asn1.Asn1[] }).value;

  // TBSCertificate fields: version(opt [0]), serialNumber, signature, issuer, ...
  // version is [0] context-specific (class=2, type=0, constructed=true)
  let issuerIdx = 2; // without version field: serialNumber(0), sigAlg(1), issuer(2)
  if (
    tbsValues[0] &&
    (tbsValues[0] as forge.asn1.Asn1).tagClass === forge.asn1.Class.CONTEXT_SPECIFIC
  ) {
    issuerIdx = 3; // with version field: version(0), serial(1), sigAlg(2), issuer(3)
  }

  const issuerAsn1 = tbsValues[issuerIdx];
  return Buffer.from(forge.asn1.toDer(issuerAsn1).getBytes(), 'binary');
}

/**
 * Extract the serial number from a certificate as a Buffer.
 * The cert.serialNumber field is a hex string; we convert it to raw bytes.
 */
export function getSerialNumberBuffer(cert: forge.pki.Certificate): Buffer {
  let hex = cert.serialNumber;
  // Ensure even number of hex digits
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function certToDer(cert: forge.pki.Certificate): Buffer {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert));
  return Buffer.from(der.getBytes(), 'binary');
}

function getSubjectStr(cert: forge.pki.Certificate): string {
  return cert.subject.attributes.map((a) => `${a.type}=${a.value}`).join(',');
}

function getIssuerStr(cert: forge.pki.Certificate): string {
  return cert.issuer.attributes.map((a) => `${a.type}=${a.value}`).join(',');
}
