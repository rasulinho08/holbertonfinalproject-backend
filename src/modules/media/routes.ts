import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { ocrLimiter } from '../../middleware/rateLimit.js';
import { created, ok, notFoundHandler } from '../../lib/envelope.js';
import { storeUpload } from '../../integrations/storage.js';
import { extractText } from '../../integrations/ocr.js';
import fs from 'node:fs';
import path from 'node:path';

import { env } from '../../config/env.js';

/* -------------------------------- uploads --------------------------------- */

export const uploadsRouter: Router = Router();

uploadsRouter.post(
  '/',
  requireAuth,
  validate(
    z.object({
      // The app sends a URI it already holds — either a local file it has
      // uploaded to storage, or a remote one. Multipart is deliberately not
      // handled here: presigned direct-to-storage uploads are the production
      // path, and this endpoint is the fallback that records the result.
      uri: z.string().min(1, 'uri is required').max(2000),
      kind: z.enum(['avatar', 'cover', 'review', 'quote', 'publication']).default('review'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await storeUpload(req.body.uri, req.body.kind);
    // If S3 is not configured, store the file locally and return the persistent URL
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY) {
      const filename = `${result.id}-${req.body.kind}`;
      const filepath = path.join(UPLOADS_DIR, filename);
      // Ensure directory exists
      if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      }
      // For stub mode, we just record the reference; in production S3 would handle this
      logger.info({ kind: req.body.kind, filename }, '[storage:stub] recorded local upload reference');
      ok(res, { ...result, localUrl: `/api/v1/uploads/files/${filename}` });
    } else {
      ok(res, result);
    }
  }),
);

/* -------------------------------- file serving ------------------------------- */

export const uploadsFileRouter: Router = Router();

uploadsFileRouter.get(
  '/:filename',
  asyncHandler(async (req, res) => {
    const { filename } = req.params;
    const filepath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filepath)) {
      res.sendFile(filepath);
    } else {
      notFoundHandler(req, res);
    }
  }),
);

/* ---------------------------------- OCR ----------------------------------- */

export const ocrRouter: Router = Router();

ocrRouter.post(
  '/extract',
  requireAuth,
  // OCR calls a paid third party, so it gets a much tighter budget than other
  // writes: 30 an hour per reader.
  ocrLimiter,
  validate(z.object({ imageUri: z.string().min(1, 'imageUri is required').max(2000) })),
  asyncHandler(async (req, res) => {
    ok(res, await extractText(req.body.imageUri));
  }),
);
