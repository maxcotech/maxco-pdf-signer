/**
 * Guards the OpenAPI contract against drift.
 *
 * The tests that matter most here are the two parity checks: every route mounted
 * on the live Express app must appear in the spec, and every error code the
 * library can throw must appear in the documented enum. Those are the failures
 * that silently rot API documentation.
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../server/app';
import type { ServerConfig } from '../server/config';
import { buildOpenApiDocument } from '../server/openapi/document';
import { ERROR_CODES, LIBRARY_ERROR_CODES } from '../server/schemas/common';
import * as lib from '../src/index';

const API_KEY = 'test-api-key-openapi-suite';
const OUTPUT = path.join(__dirname, 'output');

const testConfig: ServerConfig = {
  port: 0,
  apiKey: API_KEY,
  p12Path: path.join(__dirname, 'fixtures', 'signer-with-chain.p12'),
  p12Password: 'testpassword123',
  defaultPlaceholderSize: 16384,
  hsmTimeoutMs: 30000,
  maxUploadBytes: 25 * 1024 * 1024,
  docsEnabled: true,
};

let app: Express;

beforeAll(() => {
  app = createApp(testConfig);
});

/** Walks the Express router stack to find every mounted method + path pair. */
function mountedRoutes(expressApp: Express): string[] {
  // Express 4 exposes the root router as app._router; Express 5 as app.router.
  const root = expressApp as unknown as { _router?: any; router?: any };
  const stack = (root._router ?? root.router)?.stack ?? [];
  const found: string[] = [];

  const walk = (layers: any[], prefix: string): void => {
    for (const layer of layers) {
      if (layer.route) {
        const routePath = `${prefix}${layer.route.path}`.replace(/\/$/, '') || '/';
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) found.push(`${method.toUpperCase()} ${routePath}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Recover the mount path from the layer regexp, e.g. /^\/api\/v1\/?$/.
        const source: string = layer.regexp?.source ?? '';
        const mount = source
          .replace('^\\/', '/')
          .replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace(/\$$/, '')
          .replace(/\?$/, '');
        walk(layer.handle.stack, mount === '/' ? '' : mount);
      }
    }
  };

  walk(stack, '');
  return found;
}

describe('OpenAPI document', () => {
  it('builds a valid 3.1 document with the expected metadata', () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('pdf-signer API');
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is idempotent - repeated builds do not duplicate path registrations', () => {
    const first = buildOpenApiDocument();
    const second = buildOpenApiDocument();
    expect(second).toBe(first);
    expect(Object.keys(first.paths ?? {})).toHaveLength(3);
  });

  it('declares the x-api-key security scheme and applies it to /api/v1 routes', () => {
    const doc = buildOpenApiDocument();
    expect(doc.components?.securitySchemes?.apiKeyAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
    });
    expect(doc.paths?.['/api/v1/sign']?.post?.security).toEqual([{ apiKeyAuth: [] }]);
    // /health must stay reachable by unauthenticated probes.
    expect(doc.paths?.['/health']?.get?.security).toEqual([]);
  });

  it('documents every route that is actually mounted on the app', () => {
    const doc = buildOpenApiDocument();
    const documented = new Set<string>();
    for (const [routePath, item] of Object.entries(doc.paths ?? {})) {
      for (const method of Object.keys(item as Record<string, unknown>)) {
        documented.add(`${method.toUpperCase()} ${routePath}`);
      }
    }

    // The docs routes themselves are intentionally absent from the spec.
    const routes = mountedRoutes(app).filter(
      (r) => !r.includes('/docs') && !r.includes('/openapi.json'),
    );

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect([...documented]).toContain(route);
    }
  });

  it('documents every error code the library can throw', () => {
    // Instantiate each error class so the codes come from the library, not a copy of it.
    const thrownCodes = [
      new lib.SignatureOverflowError(1, 1).code,
      new lib.ByteRangeError('x').code,
      new lib.InvalidCertificateError('x').code,
      new lib.InvalidPdfError('x').code,
      new lib.InvalidAppearanceError('x').code,
      new lib.InvalidPositionError('x').code,
      new lib.MissingPositionError().code,
      new lib.HsmTimeoutError(1).code,
    ];

    for (const code of thrownCodes) {
      expect(ERROR_CODES).toContain(code);
    }
    // Every documented library code must correspond to something real, too.
    expect([...LIBRARY_ERROR_CODES].sort()).toEqual([...thrownCodes, 'HSM_ERROR'].sort());
  });

  it('matches the committed docs/openapi.json (run `npm run openapi:emit`)', () => {
    const committed = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'docs', 'openapi.json'), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });
});

describe('docs endpoints', () => {
  it('serves the spec without authentication', async () => {
    const res = await request(app).get('/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.1.0');
  });

  it('serves the Swagger UI shell without authentication', async () => {
    const res = await request(app).get('/docs/').expect(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('omits both when DOCS_ENABLED is false', async () => {
    const noDocs = createApp({ ...testConfig, docsEnabled: false });
    await request(noDocs).get('/openapi.json').expect(404);
    await request(noDocs).get('/docs/').expect(404);
  });
});

describe('request validation against the documented schema', () => {
  const pdf = () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'));

  it('rejects a request with no api key', async () => {
    await request(app).post('/api/v1/sign').expect(401);
  });

  it('rejects a missing pdf part with MISSING_FILE', async () => {
    const res = await request(app).post('/api/v1/sign').set('x-api-key', API_KEY).expect(400);
    expect(res.body.code).toBe('MISSING_FILE');
  });

  it('rejects a wrongly typed field with per-field details', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', pdf(), 'sample.pdf')
      .field('position', JSON.stringify({ page: 'first', x: 1, y: 1, width: 1, height: 1 }))
      .field('appearance', JSON.stringify({ text: 'Jane' }))
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'position.page' })]),
    );
  });

  it('rejects malformed JSON in a form field', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', pdf(), 'sample.pdf')
      .field('metadata', '{not json')
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details[0].message).toMatch(/valid JSON/i);
  });

  it('rejects appearance without position', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', pdf(), 'sample.pdf')
      .field('appearance', JSON.stringify({ text: 'Jane Smith' }))
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'position' })]),
    );
  });

  it('rejects an appearance with both svgString and text', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', pdf(), 'sample.pdf')
      .field('appearance', JSON.stringify({ text: 'Jane', svgString: '<svg viewBox="0 0 1 1"/>' }))
      .field('position', JSON.stringify({ page: 0, x: 1, y: 1, width: 10, height: 10 }))
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown metadata key rather than silently ignoring it', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', pdf(), 'sample.pdf')
      .field('metadata', JSON.stringify({ resaon: 'typo' }))
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('signs a PDF with no optional fields at all - only the file part', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', pdf(), 'sample.pdf')
      .expect(200);

    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(res.headers['x-document-hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(res.headers['x-byte-range'])).toHaveLength(4);
  });

  it('signs a PDF with a text stamp and full metadata', async () => {
    const res = await request(app)
      .post('/api/v1/sign')
      .set('x-api-key', API_KEY)
      .attach('pdf', pdf(), 'sample.pdf')
      .field('appearance', JSON.stringify({ text: 'Jane Smith', fontSize: 36 }))
      .field('position', JSON.stringify({ page: 0, x: 50, y: 40, width: 200, height: 60 }))
      .field(
        'metadata',
        JSON.stringify({
          reason: 'Approved',
          location: 'New York, USA',
          subFilter: 'ETSI.CAdES.detached',
        }),
      )
      .expect(200);

    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');

    // Convenience artifact for opening in Acrobat Reader, per the project's
    // testing convention. Not an assertion: on Windows this path is occasionally
    // locked by a virus scanner while the other suites run in parallel, and a
    // failed debug write should not fail a signing test that already passed.
    try {
      fs.mkdirSync(OUTPUT, { recursive: true });
      fs.writeFileSync(path.join(OUTPUT, 'api-signed-text-stamp.pdf'), res.body);
    } catch (err) {
      console.warn(`Could not write debug output PDF: ${(err as Error).message}`);
    }
  });
});
