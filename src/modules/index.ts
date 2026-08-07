import { Router } from 'express';

/**
 * The API router.
 *
 * Every module owns three files — `routes.ts` (wiring), `service.ts` (logic),
 * `schemas.ts` (Zod) — and is mounted here. Paths are declared inside each
 * module's router so this file stays a table of contents rather than a second
 * place route strings have to be kept in sync.
 */
export const apiRouter: Router = Router();

apiRouter.get('/', (_req, res) => {
  res.json({
    data: {
      name: 'KitabDostu API',
      version: 'v1',
      docs: 'See backend-guide/ENDPOINTS.md in the frontend repository',
    },
  });
});
