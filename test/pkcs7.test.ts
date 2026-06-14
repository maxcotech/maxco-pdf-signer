import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as forge from 'node-forge';
import { buildPkcs7Local, buildPkcs7Remote, buildSignedAttributes } from '../src/crypto/pkcs7Builder';
import { parseP12 } from '../src/utils/certUtils';
import { TAG_SEQUENCE, TAG_CONTEXT_0, TAG_SET } from '../src/utils/asn1Utils';

const FIXTURES = path.join(__dirname, 'fixtures');
const P12_PASSWORD = 'testpassword123';

let p12Buffer: Buffer;
let documentHash: Buffer;
let signingTime: Date;

beforeAll(() => {
  const p12Path = path.join(FIXTURES, 'signer-with-chain.p12');
  if (!fs.existsSync(p12Path)) {
    throw new Error('Test fixtures missing. Run: bash scripts/setup-test-env.sh');
  }
  p12Buffer = fs.readFileSync(p12Path);
  documentHash = crypto.createHash('sha256').update(Buffer.from('test document bytes')).digest();
  signingTime = new Date('2024-01-15T12:00:00Z');
});

describe('PKCS#7 builder', () => {
  test('buildPkcs7Local is valid DER parseable by node-forge', () => {
    const chain = parseP12(p12Buffer, P12_PASSWORD);
    const pkcs7Der = buildPkcs7Local(documentHash, chain, signingTime);

    // Should parse without throwing
    let parsed: forge.asn1.Asn1;
    expect(() => {
      parsed = forge.asn1.fromDer(
        forge.util.createBuffer(pkcs7Der.toString('binary')),
      );
    }).not.toThrow();
  });

  test('first byte is 0x30 (SEQUENCE) — RFC 5652 §3', () => {
    const chain = parseP12(p12Buffer, P12_PASSWORD);
    const pkcs7Der = buildPkcs7Local(documentHash, chain, signingTime);
    expect(pkcs7Der[0]).toBe(0x30); // TAG_SEQUENCE
  });

  test('ContentInfo OID is 1.2.840.113549.1.7.2 (SignedData)', () => {
    const chain = parseP12(p12Buffer, P12_PASSWORD);
    const pkcs7Der = buildPkcs7Local(documentHash, chain, signingTime);
    // OID bytes for 1.2.840.113549.1.7.2
    const signedDataOidHex = '06092a864886f70d010702';
    expect(pkcs7Der.toString('hex')).toContain(signedDataOidHex);
  });

  test('messageDigest attribute equals SHA-256(signableBytes)', () => {
    const { containerForm } = buildSignedAttributes(documentHash, signingTime);
    // The documentHash should appear as an OCTET STRING within the signedAttrs
    expect(containerForm.toString('hex')).toContain(documentHash.toString('hex'));
  });

  test('signedAttrs container tag is 0xA0; signingForm tag is 0x31 — RFC 5652 §5.4', () => {
    const { containerForm, signingForm } = buildSignedAttributes(documentHash, signingTime);
    // RFC 5652 §5.4 critical tag swap
    expect(containerForm[0]).toBe(0xa0); // [0] context-specific — stored in PKCS#7
    expect(signingForm[0]).toBe(0x31);   // SET — used for RSA signing operation
    // Both should have the same content (same bytes after the tag+length)
    // They share the same inner attrsContent, just different outer tags
  });

  test('CA certs appear in certificates [0] field', () => {
    const chain = parseP12(p12Buffer, P12_PASSWORD);
    const pkcs7Der = buildPkcs7Local(documentHash, chain, signingTime);
    const pkcs7Hex = pkcs7Der.toString('hex');

    // If there are CA certs, they should be present in the buffer
    if (chain.caCertsDer.length > 0) {
      const caCertHex = chain.caCertsDer[0].toString('hex').substring(0, 20);
      expect(pkcs7Hex).toContain(caCertHex);
    } else {
      // At minimum the signer cert should be present
      const signerHex = chain.signerCertDer.toString('hex').substring(0, 20);
      expect(pkcs7Hex).toContain(signerHex);
    }
  });

  test('DER long-form length encoding for containers > 127 bytes', () => {
    const { encodeDerLength } = require('../src/utils/asn1Utils');
    // Long form: length >= 128
    const encoded = encodeDerLength(300);
    // First byte should be 0x82 (0x80 | 2 bytes for length)
    expect(encoded[0]).toBe(0x82);
    expect(encoded[1]).toBe(0x01); // 300 = 0x012c
    expect(encoded[2]).toBe(0x2c);
  });

  test('signingTime in container matches parameter', () => {
    const { containerForm } = buildSignedAttributes(documentHash, signingTime);
    // UTCTime for 2024-01-15T12:00:00Z is "240115120000Z"
    const expected = Buffer.from('240115120000Z', 'ascii').toString('hex');
    expect(containerForm.toString('hex')).toContain(expected);
  });

  test('buildPkcs7Remote produces valid DER', () => {
    const chain = parseP12(p12Buffer, P12_PASSWORD);

    // Simulate what the HSM would do: sign the 0x31-tagged signedAttrs
    const { signingForm } = buildSignedAttributes(documentHash, signingTime);
    const privateKeyPem = forge.pki.privateKeyToPem(chain.privateKey!);
    const sign = crypto.createSign('SHA256');
    sign.update(signingForm);
    const hsmSignatureBytes = sign.sign(privateKeyPem);

    const pkcs7Der = buildPkcs7Remote(
      documentHash,
      chain.signerCertDer,
      chain.signerCert,
      chain.caCertsDer,
      hsmSignatureBytes,
      signingTime,
    );

    expect(pkcs7Der[0]).toBe(0x30);
    expect(pkcs7Der.length).toBeGreaterThan(100);
  });
});
