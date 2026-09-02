// VERIFICATION: a .p12 delivered as base64 text (Render Secret Files, K8s ConfigMaps,
// CI variables) must sign identically to the raw binary file.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { PdfSigner } from '../src/PdfSigner';
import { normaliseP12Bytes, parseP12 } from '../src/utils/certUtils';
import { InvalidCertificateError } from '../src/errors';

const FIXTURES = path.join(__dirname, 'fixtures');
const OUTPUT = path.join(__dirname, 'output');
const P12_PASSWORD = 'testpassword123';

let rawP12: Buffer;
let base64P12: string;
let samplePdfBuffer: Buffer;
let tmpDir: string;

beforeAll(() => {
  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });
  rawP12 = fs.readFileSync(path.join(FIXTURES, 'signer-with-chain.p12'));
  samplePdfBuffer = fs.readFileSync(path.join(FIXTURES, 'sample.pdf'));
  base64P12 = rawP12.toString('base64');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-signer-p12-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('normaliseP12Bytes — input shape detection', () => {
  test('raw DER passes through byte-identical', () => {
    const out = normaliseP12Bytes(rawP12);
    expect(out.equals(rawP12)).toBe(true);
    expect(out[0]).toBe(0x30); // PKCS#12 PFX is a DER SEQUENCE
  });

  test('base64 of a P12 always begins with M, never 0x30 — detection is unambiguous', () => {
    expect(base64P12[0]).toBe('M');
    expect(base64P12.charCodeAt(0)).not.toBe(0x30);
  });

  test('single-line base64 decodes to the original bytes', () => {
    expect(normaliseP12Bytes(Buffer.from(base64P12, 'utf8')).equals(rawP12)).toBe(true);
  });

  test('64-column wrapped base64 (openssl / macOS base64 default) decodes', () => {
    const wrapped = base64P12.replace(/(.{64})/g, '$1\n');
    expect(normaliseP12Bytes(Buffer.from(wrapped, 'utf8')).equals(rawP12)).toBe(true);
  });

  test('CRLF line endings decode — Windows clipboard paste', () => {
    const crlf = base64P12.replace(/(.{64})/g, '$1\r\n');
    expect(normaliseP12Bytes(Buffer.from(crlf, 'utf8')).equals(rawP12)).toBe(true);
  });

  test('surrounding whitespace and trailing newline decode', () => {
    const padded = `\n  ${base64P12}  \n\n`;
    expect(normaliseP12Bytes(Buffer.from(padded, 'utf8')).equals(rawP12)).toBe(true);
  });

  test('UTF-8 BOM prefix decodes — editors prepend it on save', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(base64P12, 'utf8'),
    ]);
    expect(normaliseP12Bytes(withBom).equals(rawP12)).toBe(true);
  });

  test('base64 stripped of padding still decodes', () => {
    const unpadded = base64P12.replace(/=+$/, '');
    expect(normaliseP12Bytes(Buffer.from(unpadded, 'utf8')).equals(rawP12)).toBe(true);
  });
});

describe('normaliseP12Bytes — rejection cases', () => {
  test('empty input throws INVALID_CERTIFICATE', () => {
    expect(() => normaliseP12Bytes(Buffer.alloc(0))).toThrow(InvalidCertificateError);
    expect(() => normaliseP12Bytes(Buffer.alloc(0))).toThrow(/empty/i);
  });

  test('non-DER, non-base64 bytes throw with the re-encode hint', () => {
    const junk = Buffer.from('this is definitely not a certificate!!', 'utf8');
    expect(() => normaliseP12Bytes(junk)).toThrow(InvalidCertificateError);
    expect(() => normaliseP12Bytes(junk)).toThrow(/base64 -w0/);
  });

  test('base64 of something that is not a P12 throws after decoding', () => {
    const notP12 = Buffer.from(Buffer.from('hello world', 'utf8').toString('base64'), 'utf8');
    expect(() => normaliseP12Bytes(notP12)).toThrow(/not a PKCS#12 bundle/);
  });

  test('a base64-encoded PEM is rejected rather than silently misparsed', () => {
    const pem = fs.readFileSync(path.join(FIXTURES, 'mock-hsm-cert.pem'));
    const encodedPem = Buffer.from(pem.toString('base64'), 'utf8');
    expect(() => normaliseP12Bytes(encodedPem)).toThrow(InvalidCertificateError);
  });

  test('truncated base64 (length % 4 === 1) throws a truncation error', () => {
    const stripped = base64P12.replace(/=+$/, '');
    const target = stripped.slice(0, stripped.length - (stripped.length % 4) + 1);
    expect(() => normaliseP12Bytes(Buffer.from(target, 'utf8'))).toThrow(/truncated/i);
  });
});

describe('parseP12 accepts both shapes', () => {
  test('raw and base64 forms yield the same certificate chain', () => {
    const fromRaw = parseP12(rawP12, P12_PASSWORD);
    const fromB64 = parseP12(Buffer.from(base64P12, 'utf8'), P12_PASSWORD);

    expect(fromB64.signerCertDer.equals(fromRaw.signerCertDer)).toBe(true);
    expect(fromB64.caCertsDer.length).toBe(fromRaw.caCertsDer.length);
    expect(fromB64.privateKey).toBeDefined();
  });

  test('wrong password on a base64 P12 still reports MAC failure, not a parse error', () => {
    expect(() => parseP12(Buffer.from(base64P12, 'utf8'), 'wrong-password')).toThrow(
      /MAC verification failed/,
    );
  });
});

describe('end-to-end: signing from a base64 P12 on disk (the Render Secret File case)', () => {
  test('signLocal via p12Path pointing at a base64 file produces a valid signature', async () => {
    // Exactly what Render writes to /etc/secrets/<name> from a pasted value.
    const secretFilePath = path.join(tmpDir, 'company-signing.p12');
    fs.writeFileSync(secretFilePath, base64P12.replace(/(.{76})/g, '$1\n'), 'utf8');

    const signer = new PdfSigner();
    const result = await signer.signLocal({
      pdfBuffer: samplePdfBuffer,
      p12Path: secretFilePath,
      p12Password: P12_PASSWORD,
      reason: 'base64 secret file',
      signerName: 'Render Deploy Test',
    });

    // CLAUDE.md section 9: verify documentHash independently against the ByteRange bytes
    const [o1, l1, o2, l2] = result.byteRange;
    const seg1 = result.signedPdf.subarray(o1, o1 + l1);
    const seg2 = result.signedPdf.subarray(o2, o2 + l2);
    const expected = crypto
      .createHash('sha256')
      .update(Buffer.concat([seg1, seg2]))
      .digest('hex');

    expect(result.documentHash).toBe(expected);
    expect(result.signedPdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(result.pkcs7Hex.slice(0, 2)).toBe('30'); // top-level DER SEQUENCE

    const integrity = await signer.verifyByteRangeIntegrity(result.signedPdf);
    expect(integrity.valid).toBe(true);

    fs.writeFileSync(path.join(OUTPUT, 'base64-p12-signed.pdf'), result.signedPdf);
  });

  test('raw binary p12Path still works — no regression', async () => {
    const signer = new PdfSigner();
    const result = await signer.signLocal({
      pdfBuffer: samplePdfBuffer,
      p12Path: path.join(FIXTURES, 'signer-with-chain.p12'),
      p12Password: P12_PASSWORD,
    });

    const integrity = await signer.verifyByteRangeIntegrity(result.signedPdf);
    expect(integrity.valid).toBe(true);
  });

  test('a corrupted secret file fails loudly with an actionable message', async () => {
    const badPath = path.join(tmpDir, 'corrupt.p12');
    fs.writeFileSync(badPath, 'oops-I-pasted-the-wrong-thing', 'utf8');

    const signer = new PdfSigner();
    await expect(
      signer.signLocal({
        pdfBuffer: samplePdfBuffer,
        p12Path: badPath,
        p12Password: P12_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CERTIFICATE' });
  });
});
