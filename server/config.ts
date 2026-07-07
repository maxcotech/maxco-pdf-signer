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

export interface ServerConfig {
  port: number;
  apiKey: string;
  p12Path: string;
  p12Password: string;
  defaultPlaceholderSize: number;
  hsmTimeoutMs: number;
  maxUploadBytes: number;
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
  };
}
