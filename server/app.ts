import express, { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import { ServerConfig } from './config';
import { buildOpenApiDocument } from './openapi/document';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { errorHandler } from './middleware/errorHandler';
import { createSignRouter } from './routes/sign';
import { createInspectRouter } from './routes/inspect';

export function createApp(config: ServerConfig): Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'pdf-signer-api' });
  });

  // Mounted ABOVE the apiKeyAuth middleware on purpose: a browser cannot supply
  // the x-api-key header when fetching the Swagger UI shell, so gating these
  // routes with auth would make the docs unreachable. Use DOCS_ENABLED=false to
  // turn them off instead. Swagger UI's own Authorize button supplies the key
  // for "Try it out" requests.
  if (config.docsEnabled) {
    const openApiDocument = buildOpenApiDocument();
    app.get('/openapi.json', (_req, res) => {
      res.json(openApiDocument);
    });
    app.use(
      '/docs',
      swaggerUi.serve,
      swaggerUi.setup(openApiDocument, {
        customSiteTitle: 'pdf-signer API',
        swaggerOptions: { persistAuthorization: true },
      }),
    );
  }

  const authenticated = apiKeyAuth(config.apiKey);
  app.use('/api/v1', authenticated, createInspectRouter(config));
  app.use('/api/v1', authenticated, createSignRouter(config));

  app.use(errorHandler);

  return app;
}
