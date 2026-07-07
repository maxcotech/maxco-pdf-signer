import express, { Express } from 'express';
import { ServerConfig } from './config';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { errorHandler } from './middleware/errorHandler';
import { createSignRouter } from './routes/sign';

export function createApp(config: ServerConfig): Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'pdf-signer-api' });
  });

  app.use('/api/v1', apiKeyAuth(config.apiKey), createSignRouter(config));

  app.use(errorHandler);

  return app;
}
