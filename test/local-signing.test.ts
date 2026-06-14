import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PdfSigner } from '../src/PdfSigner';
import { PdfEngine } from '../src/engine/PdfEngine';
import {
  MissingPositionError,
  SignatureOverflowError,
  InvalidCertificateError,
} from '../src/errors';

const FIXTURES = path.join(__dirname, 'fixtures');
const OUTPUT = path.join(__dirname, 'output');

let samplePdfBuffer: Buffer;
let p12Buffer: Buffer;
let sampleSvgString: string;
const P12_PASSWORD = 'testpassword123';

beforeAll(() => {
  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  const pdfPath = path.join(FIXTURES, 'sample.pdf');
  const p12Path = path.join(FIXTURES, 'signer-with-chain.p12');
  const svgPath = path.join(FIXTURES, 'sample-signature.svg');

  if (!fs.existsSync(pdfPath) || !fs.existsSync(p12Path)) {
    throw new Error(
      'Test fixtures missing. Run: bash scripts/setup-test-env.sh',
    );
  }

  samplePdfBuffer = fs.readFileSync(pdfPath);
  p12Buffer = fs.readFileSync(p12Path);
  sampleSvgString = fs.readFileSync(svgPath, 'utf8');
});

describe('Local signing (Path A)', () => {
  const signer = new PdfSigner();

  test('signs with SVG stamp — ByteRange consistent, stamp visible', async () => {
    const result = await signer.signLocal({
      pdfBuffer: samplePdfBuffer,
      p12Buffer,
      p12Password: P12_PASSWORD,
      appearance: { svgString: sampleSvgString },
      position: { page: 0, x: 50, y: 50, width: 200, height: 60 },
      reason: 'Approved',
      location: 'New York, USA',
    });

    expect(result.signedPdf).toBeInstanceOf(Buffer);
    expect(result.signedPdf.length).toBeGreaterThan(samplePdfBuffer.length);
    expect(result.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pkcs7Hex).toMatch(/^[0-9a-f]+$/);

    // ByteRange should be 4 non-zero values
    expect(result.byteRange[0]).toBe(0);
    expect(result.byteRange[1]).toBeGreaterThan(0);
    expect(result.byteRange[2]).toBeGreaterThan(result.byteRange[1]);
    expect(result.byteRange[3]).toBeGreaterThan(0);

    // ByteRange integrity
    const integrity = await signer.verifyByteRangeIntegrity(result.signedPdf);
    expect(integrity.valid).toBe(true);
    expect(integrity.details.errors).toHaveLength(0);

    fs.writeFileSync(path.join(OUTPUT, 'local-signed-with-svg.pdf'), result.signedPdf);
  });

  test('signs with text stamp', async () => {
    const result = await signer.signLocal({
      pdfBuffer: samplePdfBuffer,
      p12Buffer,
      p12Password: P12_PASSWORD,
      appearance: { text: 'Jane Smith', fontSize: 36, color: '#1a3a6e' },
      position: { page: 0, x: 80, y: 100, width: 220, height: 70 },
    });

    expect(result.signedPdf.length).toBeGreaterThan(samplePdfBuffer.length);

    const integrity = await signer.verifyByteRangeIntegrity(result.signedPdf);
    expect(integrity.valid).toBe(true);

    fs.writeFileSync(path.join(OUTPUT, 'local-signed-with-text.pdf'), result.signedPdf);
  });

  test('signs without appearance (cryptographic-only)', async () => {
    const result = await signer.signLocal({
      pdfBuffer: samplePdfBuffer,
      p12Buffer,
      p12Password: P12_PASSWORD,
    });

    expect(result.signedPdf).toBeInstanceOf(Buffer);

    const integrity = await signer.verifyByteRangeIntegrity(result.signedPdf);
    expect(integrity.valid).toBe(true);

    fs.writeFileSync(path.join(OUTPUT, 'local-signed-no-stamp.pdf'), result.signedPdf);
  });

  test('throws MissingPositionError when appearance provided without position', async () => {
    await expect(
      signer.signLocal({
        pdfBuffer: samplePdfBuffer,
        p12Buffer,
        p12Password: P12_PASSWORD,
        appearance: { svgString: sampleSvgString },
        // no position
      }),
    ).rejects.toThrow(MissingPositionError);
  });

  test('documentHash matches independently computed SHA-256 of ByteRange bytes', async () => {
    const result = await signer.signLocal({
      pdfBuffer: samplePdfBuffer,
      p12Buffer,
      p12Password: P12_PASSWORD,
    });

    const [o1, l1, o2, l2] = result.byteRange;
    const segment1 = result.signedPdf.subarray(o1, o1 + l1);
    const segment2 = result.signedPdf.subarray(o2, o2 + l2);
    const combined = Buffer.concat([segment1, segment2]);
    const expectedHash = crypto.createHash('sha256').update(combined).digest('hex');

    expect(result.documentHash).toBe(expectedHash);
  });

  test('ByteRange invariant: segment1 + contentsSlot + segment2 = file size', async () => {
    const result = await signer.signLocal({
      pdfBuffer: samplePdfBuffer,
      p12Buffer,
      p12Password: P12_PASSWORD,
    });

    const integrity = await signer.verifyByteRangeIntegrity(result.signedPdf);
    expect(integrity.valid).toBe(true);
    // File size = length1 + 1('<') + contentsSlot + 1('>') + length2
    const [, l1, , l2] = result.byteRange;
    expect(l1 + 1 + integrity.details.contentsSlotSize + 1 + l2).toBe(
      result.signedPdf.length,
    );
  });

  test('PKCS#7 contains certificates (signer + chain)', async () => {
    const result = await signer.signLocal({
      pdfBuffer: samplePdfBuffer,
      p12Buffer,
      p12Password: P12_PASSWORD,
    });

    // PKCS#7 first byte should be 0x30 (SEQUENCE) per DER
    const pkcs7Bytes = Buffer.from(result.pkcs7Hex, 'hex');
    expect(pkcs7Bytes[0]).toBe(0x30);

    // Should have reasonable size (>= 500 bytes for a cert chain)
    expect(pkcs7Bytes.length).toBeGreaterThan(500);
  });

  test('throws SignatureOverflowError with guidance when placeholder too small', async () => {
    await expect(
      signer.signLocal({
        pdfBuffer: samplePdfBuffer,
        p12Buffer,
        p12Password: P12_PASSWORD,
        placeholderSizeBytes: 1, // impossibly small
      }),
    ).rejects.toThrow(SignatureOverflowError);
  });

  test('throws InvalidCertificateError on wrong P12 password', async () => {
    await expect(
      signer.signLocal({
        pdfBuffer: samplePdfBuffer,
        p12Buffer,
        p12Password: 'wrongpassword',
      }),
    ).rejects.toThrow(InvalidCertificateError);
  });
});
