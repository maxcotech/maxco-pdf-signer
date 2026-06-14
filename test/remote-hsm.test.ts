import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PdfSigner } from '../src/PdfSigner';
import { HsmTimeoutError } from '../src/errors';

const FIXTURES = path.join(__dirname, 'fixtures');
const OUTPUT = path.join(__dirname, 'output');

let samplePdfBuffer: Buffer;
let mockHsmKeyPem: string;
let mockHsmCertPem: string;
let sampleSvgString: string;

/**
 * Mock HSM sign function — uses crypto.createSign('SHA256') which hashes internally.
 * Equivalent to Azure Key Vault RS256 or GCP Cloud KMS behavior.
 * For AWS KMS with MessageType:'DIGEST', you would pre-hash: sha256(signedAttrsBytes).
 */
function mockHsmSignFunction(signedAttrsBytes: Buffer): Promise<Buffer> {
  const sign = crypto.createSign('SHA256');
  sign.update(signedAttrsBytes);
  const sig = sign.sign(mockHsmKeyPem);
  return Promise.resolve(sig);
}

beforeAll(() => {
  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  const pdfPath = path.join(FIXTURES, 'sample.pdf');
  const keyPath = path.join(FIXTURES, 'mock-hsm-key.pem');
  const certPath = path.join(FIXTURES, 'mock-hsm-cert.pem');
  const svgPath = path.join(FIXTURES, 'sample-signature.svg');

  if (!fs.existsSync(pdfPath) || !fs.existsSync(keyPath)) {
    throw new Error(
      'Test fixtures missing. Run: bash scripts/setup-test-env.sh',
    );
  }

  samplePdfBuffer = fs.readFileSync(pdfPath);
  mockHsmKeyPem = fs.readFileSync(keyPath, 'utf8');
  mockHsmCertPem = fs.readFileSync(certPath, 'utf8');
  sampleSvgString = fs.readFileSync(svgPath, 'utf8');
});

describe('Remote HSM signing (Path B)', () => {
  const signer = new PdfSigner({ hsmTimeoutMs: 10000 });

  test('signs PDF with SVG stamp via mock HSM — ByteRange valid', async () => {
    const result = await signer.signRemote({
      pdfBuffer: samplePdfBuffer,
      signerCertPem: mockHsmCertPem,
      hsmSignFunction: mockHsmSignFunction,
      appearance: { svgString: sampleSvgString },
      position: { page: 0, x: 50, y: 50, width: 200, height: 60 },
      reason: 'Remote HSM signing test',
    });

    expect(result.signedPdf).toBeInstanceOf(Buffer);
    expect(result.documentHash).toMatch(/^[0-9a-f]{64}$/);

    const integrity = await signer.verifyByteRangeIntegrity(result.signedPdf);
    expect(integrity.valid).toBe(true);
    expect(integrity.details.errors).toHaveLength(0);

    fs.writeFileSync(path.join(OUTPUT, 'remote-hsm-signed.pdf'), result.signedPdf);
  });

  test('signs PDF without stamp via mock HSM', async () => {
    const result = await signer.signRemote({
      pdfBuffer: samplePdfBuffer,
      signerCertPem: mockHsmCertPem,
      hsmSignFunction: mockHsmSignFunction,
    });

    const integrity = await signer.verifyByteRangeIntegrity(result.signedPdf);
    expect(integrity.valid).toBe(true);
  });

  test('documentHash in result matches independently computed hash', async () => {
    const result = await signer.signRemote({
      pdfBuffer: samplePdfBuffer,
      signerCertPem: mockHsmCertPem,
      hsmSignFunction: mockHsmSignFunction,
    });

    const [o1, l1, o2, l2] = result.byteRange;
    const segment1 = result.signedPdf.subarray(o1, o1 + l1);
    const segment2 = result.signedPdf.subarray(o2, o2 + l2);
    const expectedHash = crypto.createHash('sha256')
      .update(Buffer.concat([segment1, segment2]))
      .digest('hex');

    expect(result.documentHash).toBe(expectedHash);
  });

  test('throws HsmTimeoutError when callback never resolves', async () => {
    const neverResolves = () => new Promise<Buffer>(() => { /* intentionally hangs */ });
    const fastSigner = new PdfSigner({ hsmTimeoutMs: 500 });

    await expect(
      fastSigner.signRemote({
        pdfBuffer: samplePdfBuffer,
        signerCertPem: mockHsmCertPem,
        hsmSignFunction: neverResolves,
      }),
    ).rejects.toThrow(HsmTimeoutError);
  }, 10000);

  test('wraps HSM network error as descriptive PdfSignerError', async () => {
    const failingHsm = async (_: Buffer): Promise<Buffer> => {
      throw new Error('Network connection refused');
    };

    await expect(
      signer.signRemote({
        pdfBuffer: samplePdfBuffer,
        signerCertPem: mockHsmCertPem,
        hsmSignFunction: failingHsm,
      }),
    ).rejects.toMatchObject({ code: 'HSM_ERROR' });
  });
});
