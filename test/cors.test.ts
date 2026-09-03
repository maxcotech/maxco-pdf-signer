/**
 * Cross-origin access control.
 *
 * A browser enforces CORS, so a server-side test cannot observe a block — it can
 * only assert the headers the browser decides on. The assertions that matter are
 * therefore the two silent failure modes:
 *
 *   1. a preflight reaching apiKeyAuth and 401-ing (it carries no x-api-key), and
 *   2. a successful sign whose X-* headers are unreadable to the caller because
 *      they were never exposed — which surfaces as an empty documentHash rather
 *      than as an error.
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import { loadConfig } from '../server/config';

const API_KEY = 'test-api-key-cors-suite';
const ALLOWED = 'https://signsig-business-dev.netlify.app';
const ALLOWED_LOCAL = 'http://localhost:3100';

const testConfig: ServerConfig = {
  port: 0,
  apiKey: API_KEY,
  p12Path: path.join(__dirname, 'fixtures', 'signer-with-chain.p12'),
  p12Password: 'testpassword123',
  defaultPlaceholderSize: 16384,
  hsmTimeoutMs: 30000,
  maxUploadBytes: 25 * 1024 * 1024,
  docsEnabled: false,
  corsOrigins: [ALLOWED_LOCAL, ALLOWED],
};

const samplePdf = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));

let app: Express;

beforeAll(() => {
  app = createApp(testConfig);
});

describe('CORS allowlist', () => {
  it.each([ALLOWED_LOCAL, ALLOWED])('echoes the allowlisted origin %s', async (origin) => {
    const res = await request(app).get('/health').set('Origin', origin);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers.vary).toContain('Origin');
  });

  it('sends no allow-origin header for an origin outside the list', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');

    // Still 200 — the server does not reject, the browser does.
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.vary).toContain('Origin');
  });

  it('answers a preflight without an API key', async () => {
    const res = await request(app)
      .options('/api/v1/sign')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-api-key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    // Not a safelisted request header: omitting it fails every authenticated call.
    expect(res.headers['access-control-allow-headers']).toContain('x-api-key');
  });

  it('allows whatever headers the preflight asks for', async () => {
    // Regression: a frontend HTTP wrapper adding its own header (`timezone` here)
    // was blocked by a hardcoded allow-list. The origin allowlist is the
    // boundary; once past it, a client picks its own request headers.
    const res = await request(app)
      .options('/api/v1/sign')
      .set('Origin', ALLOWED_LOCAL)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-api-key,timezone,content-type');

    expect(res.status).toBe(204);
    const allowedHeaders = res.headers['access-control-allow-headers'];
    for (const header of ['x-api-key', 'timezone', 'content-type']) {
      expect(allowedHeaders).toContain(header);
    }
    // A cache must not reuse this reply for a preflight asking for other headers.
    expect(res.headers.vary).toContain('Access-Control-Request-Headers');
  });

  it('falls back to the known headers when a preflight names none', async () => {
    const res = await request(app)
      .options('/api/v1/sign')
      .set('Origin', ALLOWED_LOCAL)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toContain('x-api-key');
  });

  it('reflects nothing for an unlisted origin, whatever it asks for', async () => {
    const res = await request(app)
      .options('/api/v1/sign')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-api-key,timezone');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
  });

  it('exposes the signing result headers to a cross-origin caller', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .set('Origin', ALLOWED)
      .attach('pdf', samplePdf(), 'sample.pdf');

    expect(res.status).toBe(200);

    const exposed = res.headers['access-control-expose-headers'];
    for (const header of ['X-Document-Hash', 'X-Byte-Range', 'X-Signing-Time', 'X-Stamp-Rect']) {
      expect(exposed).toContain(header);
    }
    // The header is actually set, so exposing it is not theoretical.
    expect(res.headers['x-document-hash']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('CORS_ORIGINS configuration', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to the two known browser clients', () => {
    delete process.env.CORS_ORIGINS;
    process.env.API_KEY = API_KEY;
    process.env.P12_PATH = testConfig.p12Path;
    process.env.P12_PASSWORD = testConfig.p12Password;

    expect(loadConfig().corsOrigins).toEqual([ALLOWED_LOCAL, ALLOWED]);
  });

  it('splits the env list and strips whitespace and trailing slashes', () => {
    process.env.CORS_ORIGINS = ' https://a.example.com/ , https://b.example.com ,,';
    process.env.API_KEY = API_KEY;
    process.env.P12_PATH = testConfig.p12Path;
    process.env.P12_PASSWORD = testConfig.p12Password;

    expect(loadConfig().corsOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});
