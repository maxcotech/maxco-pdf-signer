/**
 * Writes the generated OpenAPI document to docs/openapi.json.
 *
 * The file is committed so that (a) consumers can generate client SDKs from a
 * stable URL-free artifact and (b) CI can detect a schema change that was not
 * regenerated — see the `openapi:check` npm script.
 */
import fs from 'fs';
import path from 'path';
import { buildOpenApiDocument } from '../server/openapi/document';

const outPath = path.resolve(__dirname, '..', 'docs', 'openapi.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`, 'utf8');

console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
