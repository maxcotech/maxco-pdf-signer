import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example for the full list.`,
    );
  }
  return value;
}

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3100',
  'https://signsig-business-dev.netlify.app',
];

function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
}

export interface ServerConfig {
  port: number;
  apiKey: string;
  p12Path: string;
  p12Password: string;
  defaultPlaceholderSize: number;
  hsmTimeoutMs: number;
  maxUploadBytes: number;
  docsEnabled: boolean;
  corsOrigins: string[];
}

export function loadConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    apiKey: requireEnv('API_KEY'),
    p12Path: path.resolve(requireEnv('P12_PATH')),
    p12Password: requireEnv('P12_PASSWORD'),
    defaultPlaceholderSize: Number(process.env.DEFAULT_PLACEHOLDER_SIZE ?? 16384),
    hsmTimeoutMs: Number(process.env.HSM_TIMEOUT_MS ?? 30000),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024,
    // Serves /docs and /openapi.json. These are unauthenticated by design (the
    // Swagger UI shell has to load before the user can enter an API key), so
    // disable them on internet-facing deployments.
    docsEnabled: (process.env.DOCS_ENABLED ?? 'true').toLowerCase() !== 'false',
    // Browser origins allowed to call the API cross-origin. Comma-separated;
    // each entry must be a bare scheme+host+port with no trailing slash, because
    // it is compared literally against the request's Origin header.
    corsOrigins: parseOrigins(process.env.CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS.join(',')),
  };
}
