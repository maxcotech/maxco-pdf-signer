/**
 * The typed client, exercised against a real listening server.
 *
 * These tests deliberately go over a socket rather than mocking fetch. The whole
 * reason the client exists is that hand-built multipart bodies for this endpoint
 * are easy to get subtly wrong — JSON-in-a-form-field being the trap — so a test
 * that stubs the transport would validate nothing that matters.
 */
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';

import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import { PdfSignerClient, PdfSignerApiError } from '../client/index';

const API_KEY = 'test-api-key-client-suite';

const testConfig: ServerConfig = {
  port: 0,
  apiKey: API_KEY,
  p12Path: path.join(__dirname, 'fixtures', 'signer-with-chain.p12'),
  p12Password: 'testpassword123',
  defaultPlaceholderSize: 16384,
  hsmTimeoutMs: 30000,
  maxUploadBytes: 25 * 1024 * 1024,
  docsEnabled: false,
  corsOrigins: ['http://localhost:3100'],
};

const samplePdf = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));

let server: Server;
let client: PdfSignerClient;

beforeAll(async () => {
  const app = createApp(testConfig);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to bind a TCP port');
  }

  client = new PdfSignerClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: API_KEY,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('PdfSignerClient construction', () => {
  it('requires a baseUrl and an apiKey', () => {
    expect(() => new PdfSignerClient({ baseUrl: '', apiKey: 'k' })).toThrow(/baseUrl/);
    expect(() => new PdfSignerClient({ baseUrl: 'http://x', apiKey: '' })).toThrow(/apiKey/);
  });

  it('tolerates a trailing slash on the baseUrl', async () => {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const trailing = new PdfSignerClient({
      baseUrl: `http://127.0.0.1:${address.port}/`,
      apiKey: API_KEY,
    });
    await expect(trailing.health()).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('inspect()', () => {
  it('returns typed page geometry', async () => {
    const result = await client.inspect(samplePdf());

    expect(result.pageCount).toBe(2);
    expect(result.pages[0].widthPts).toBe(612);
    expect(result.pages[0].heightPts).toBe(792);
    expect(result.encrypted).toBe(false);
    expect(result.signable).toBe(true);
  });

  it('surfaces a bad upload as a typed error with a stable code', async () => {
    await expect(client.inspect(Buffer.from('not a pdf'))).rejects.toMatchObject({
      name: 'PdfSignerApiError',
      code: 'INVALID_PDF',
      status: 400,
    });
  });
});

describe('sign()', () => {
  it('signs with no stamp and returns the hash and byte range', async () => {
    const result = await client.sign({ pdf: samplePdf() });

    expect(Buffer.from(result.signedPdf).subarray(0, 4).toString()).toBe('%PDF');
    expect(result.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteRange).toHaveLength(4);
    expect(result.signingTime).not.toBe('');
    expect(result.stampRect).toBeUndefined();
  });

  it('signs with a text stamp and reports the resolved rectangle', async () => {
    const result = await client.sign({
      pdf: samplePdf(),
      appearance: { text: 'Jane Smith', fontSize: 36 },
      position: { page: 0, x: 50, y: 40, width: 200, height: 60 },
      metadata: { reason: 'Approved', location: 'Lagos, Nigeria' },
    });

    expect(result.stampRect).toEqual({ page: 0, x: 50, y: 40, width: 200, height: 60 });
  });

  it('sends objects as JSON form fields the server accepts', async () => {
    // The regression this guards: appending the objects to FormData directly
    // serialises them as "[object Object]" and the request fails validation.
    // Passing structured metadata through successfully is the proof it does not.
    const result = await client.sign({
      pdf: samplePdf(),
      appearance: { text: 'Jane Smith' },
      position: { page: 1, x: 50, y: 40, width: 200, height: 60 },
      metadata: {
        reason: 'Approved',
        location: 'Lagos, Nigeria',
        contactInfo: 'signing@example.com',
        signerName: 'Jane Smith',
        subFilter: 'ETSI.CAdES.detached',
      },
    });

    expect(result.stampRect?.page).toBe(1);
  });

  it('accepts a Date for signingDate and sends it as ISO 8601', async () => {
    const signingDate = new Date('2026-03-04T05:06:07.000Z');
    const result = await client.sign({ pdf: samplePdf(), metadata: { signingDate } });
    expect(result.signingTime).toBe(signingDate.toISOString());
  });

  it('converts a browser rectangle server-side', async () => {
    const result = await client.sign({
      pdf: samplePdf(),
      appearance: { text: 'Jane Smith' },
      position: {
        page: 0,
        x: 100,
        y: 200,
        width: 300,
        height: 90,
        origin: 'top-left',
        units: 'px',
        viewportWidth: 1000,
      },
    });

    const scale = 612 / 1000;
    expect(result.stampRect!.x).toBeCloseTo(100 * scale, 6);
    expect(result.stampRect!.y).toBeCloseTo(792 - 200 * scale - 90 * scale, 6);
  });

  it('catches appearance-without-position before making a request', async () => {
    await expect(
      client.sign({ pdf: samplePdf(), appearance: { text: 'Jane' } }),
    ).rejects.toThrow(/requires `position`/);
  });

  it('catches position-without-appearance before making a request', async () => {
    await expect(
      client.sign({
        pdf: samplePdf(),
        position: { page: 0, x: 1, y: 1, width: 10, height: 10 },
      }),
    ).rejects.toThrow(/nothing to draw/);
  });

  it('reports per-field validation detail from the server', async () => {
    const error = await client
      .sign({
        pdf: samplePdf(),
        appearance: { text: 'Jane' },
        position: {
          page: 0,
          x: 1,
          y: 1,
          width: 10,
          height: 10,
          units: 'px', // no viewport
        },
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PdfSignerApiError);
    const apiError = error as PdfSignerApiError;
    expect(apiError.code).toBe('VALIDATION_ERROR');
    expect(apiError.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'position.viewportWidth' })]),
    );
  });

  it('rejects a bad api key with UNAUTHORIZED', async () => {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const wrongKey = new PdfSignerClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'wrong-key',
    });

    await expect(wrongKey.sign({ pdf: samplePdf() })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
  });
});

describe('PdfSignerApiError', () => {
  it('suggests a retry size only for SIGNATURE_OVERFLOW', () => {
    const overflow = new PdfSignerApiError('too big', 400, 'SIGNATURE_OVERFLOW', {
      actualBytes: 17004,
      allocatedBytes: 16384,
    });
    expect(overflow.suggestedPlaceholderSize).toBe(17004 + 512);

    const other = new PdfSignerApiError('nope', 400, 'INVALID_PDF');
    expect(other.suggestedPlaceholderSize).toBeUndefined();
  });

  it('drives a placeholder-size retry end to end', async () => {
    // A 512-byte slot cannot hold a three-certificate chain, so the first
    // attempt overflows and the error carries the size needed. This is the
    // recovery loop the docs prescribe.
    const request = {
      pdf: samplePdf(),
      metadata: { placeholderSizeBytes: 512 },
    };

    const error = await client.sign(request).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PdfSignerApiError);

    const retrySize = (error as PdfSignerApiError).suggestedPlaceholderSize;
    expect(retrySize).toBeGreaterThan(512);

    const result = await client.sign({
      ...request,
      metadata: { placeholderSizeBytes: retrySize },
    });
    expect(Buffer.from(result.signedPdf).subarray(0, 4).toString()).toBe('%PDF');
  });
});
