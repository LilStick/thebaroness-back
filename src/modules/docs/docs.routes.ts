import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from '../../docs/openapi';

/** `/api/openapi.json` (contrat brut) et `/api/docs` (Swagger UI), publics en lecture. */
export function createDocsRouter(): Router {
  const router = Router();

  router.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  router.use(
    '/docs',
    // Swagger UI charge ses propres scripts et styles : CSP assouplie sur cette seule route.
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    }),
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'thebaroness API',
      swaggerOptions: { persistAuthorization: false },
    }),
  );

  return router;
}
