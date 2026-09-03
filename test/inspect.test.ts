/**
 * Document inspection, at both the library and HTTP layers.
 *
 * The point of these tests is that the numbers reported are the numbers a stamp
 * rectangle has to be built from — so they assert the actual geometry of the
 * fixture, not merely that fields are present.
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import { inspectPdf, PdfSigner, InvalidPdfError } from '../src/index';

const API_KEY = 'test-api-key-inspect-suite';

const testConfig: ServerConfig = {
  port: 0,
  apiKey: API_KEY,
  p12Path: path.join(__dirname, 'fixtures', 'signer-with-chain.p12'),
  p12Password: 'testpassword123',
  defaultPlaceholderSize: 16384,
  hsmTimeoutMs: 30000,
  maxUploadBytes: 25 * 1024 * 1024,
  docsEnabled: false,
};

const samplePdf = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));

let app: Express;

beforeAll(() => {
  app = createApp(testConfig);
});

describe('inspectPdf', () => {
  it('reports the page count and per-page geometry in points', async () => {
    const result = await inspectPdf(samplePdf());

    expect(result.pageCount).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toEqual({
      index: 0,
      widthPts: 612,
      heightPts: 792,
      rotation: 0,
      displayWidthPts: 612,
      displayHeightPts: 792,
    });
    expect(result.pages[1].index).toBe(1);
  });

  it('reports an unsigned document as signable with no signatures', async () => {
    const result = await inspectPdf(samplePdf());
    expect(result.encrypted).toBe(false);
    expect(result.signatureCount).toBe(0);
    expect(result.signable).toBe(true);
    expect(result.sizeBytes).toBe(samplePdf().length);
  });

  it('detects a signature once the document has been signed', async () => {
    const signer = new PdfSigner();
    const signed = await signer.signLocal({
      pdfBuffer: samplePdf(),
      p12Path: testConfig.p12Path,
      p12Password: testConfig.p12Password,
    });

    const result = await inspectPdf(signed.signedPdf);
    expect(result.signatureCount).toBeGreaterThan(0);
    // Still structurally signable — counter-signing is legitimate. The count is
    // what tells a caller the upload was not fresh.
    expect(result.signable).toBe(true);
  });

  it('does not modify the document it inspects', async () => {
    const before = samplePdf();
    await inspectPdf(before);
    expect(before.equals(samplePdf())).toBe(true);
  });

  it('throws InvalidPdfError on a buffer that is not a PDF', async () => {
    await expect(inspectPdf(Buffer.from('this is not a pdf'))).rejects.toThrow(InvalidPdfError);
  });

  it('is reachable from the PdfSigner facade', async () => {
    const signer = new PdfSigner();
    const result = await signer.inspect(samplePdf());
    expect(result.pageCount).toBe(2);
  });
});

describe('POST /api/v1/documents/inspect', () => {
  it('requires an api key', async () => {
    await request(app).post('/api/v1/documents/inspect').expect(401);
  });

  it('returns the geometry as JSON', async () => {
    const res = await request(app)
      .post('/api/v1/documents/inspect')
      .set('x-api-key', API_KEY)
      .attach('pdf', samplePdf(), 'sample.pdf')
      .expect(200);

    expect(res.body).toMatchObject({
      pageCount: 2,
      encrypted: false,
      signatureCount: 0,
      signable: true,
    });
    expect(res.body.pages[0]).toMatchObject({ index: 0, widthPts: 612, heightPts: 792 });
  });

  it('rejects a request with no pdf part', async () => {
    const res = await request(app)
      .post('/api/v1/documents/inspect')
      .set('x-api-key', API_KEY)
      .expect(400);
    expect(res.body.code).toBe('MISSING_FILE');
  });

  it('rejects a non-PDF upload with INVALID_PDF', async () => {
    const res = await request(app)
      .post('/api/v1/documents/inspect')
      .set('x-api-key', API_KEY)
      .attach('pdf', Buffer.from('not a pdf at all'), 'fake.pdf')
      .expect(400);
    expect(res.body.code).toBe('INVALID_PDF');
  });

  it('produces geometry that feeds straight into a working sign call', async () => {
    // The integration this endpoint exists for: inspect, place against the
    // reported page size, sign.
    const inspection = await request(app)
      .post('/api/v1/documents/inspect')
      .set('x-api-key', API_KEY)
      .attach('pdf', samplePdf(), 'sample.pdf')
      .expect(200);

    const page = inspection.body.pages[0];
    const width = 200;
    const height = 60;

    const signed = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', samplePdf(), 'sample.pdf')
      .field('appearance', JSON.stringify({ text: 'Jane Smith' }))
      .field(
        'position',
        // 40pt in from the bottom-right corner, derived from the reported size.
        JSON.stringify({
          page: page.index,
          x: page.widthPts - width - 40,
          y: 40,
          width,
          height,
        }),
      )
      .expect(200);

    expect(signed.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(JSON.parse(signed.headers['x-stamp-rect'])).toEqual({
      page: 0,
      x: 612 - 200 - 40,
      y: 40,
      width: 200,
      height: 60,
    });
  });
});

describe('POST /api/v1/sign — coordinate space conversion', () => {
  const signWith = (position: Record<string, unknown>) =>
    request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', samplePdf(), 'sample.pdf')
      .field('appearance', JSON.stringify({ text: 'Jane Smith' }))
      .field('position', JSON.stringify(position));

  it('converts a browser rectangle and reports where it landed', async () => {
    const res = await signWith({
      page: 0,
      x: 100,
      y: 200,
      width: 300,
      height: 90,
      origin: 'top-left',
      units: 'px',
      viewportWidth: 1000,
    }).expect(200);

    const scale = 612 / 1000;
    const rect = JSON.parse(res.headers['x-stamp-rect']);
    expect(rect.x).toBeCloseTo(100 * scale, 6);
    expect(rect.width).toBeCloseTo(300 * scale, 6);
    expect(rect.y).toBeCloseTo(792 - 200 * scale - 90 * scale, 6);
  });

  it('omits X-Stamp-Rect when no stamp was applied', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', samplePdf(), 'sample.pdf')
      .expect(200);

    expect(res.headers['x-stamp-rect']).toBeUndefined();
  });

  it('rejects px units with no viewport, naming the field', async () => {
    const res = await signWith({
      page: 0,
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      units: 'px',
    }).expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'position.viewportWidth' })]),
    );
  });

  it('rejects viewport fields sent with point units', async () => {
    const res = await signWith({
      page: 0,
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      viewportWidth: 1000,
    }).expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'position.units' })]),
    );
  });

  it('rejects an unknown origin value rather than defaulting silently', async () => {
    const res = await signWith({
      page: 0,
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      origin: 'centre',
    }).expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an off-page rectangle with INVALID_POSITION', async () => {
    const res = await signWith({
      page: 0,
      x: 50,
      y: 5000,
      width: 200,
      height: 60,
    }).expect(400);

    expect(res.body.code).toBe('INVALID_POSITION');
    expect(res.body.error).toMatch(/lies entirely outside/);
  });
});
