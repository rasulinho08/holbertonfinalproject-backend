import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { ocrLimiter } from '../../middleware/rateLimit.js';
import { created, ok } from '../../lib/envelope.js';
import { storeUpload } from '../../integrations/storage.js';
import { extractText } from '../../integrations/ocr.js';

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
    created(res, await storeUpload(req.body.uri, req.body.kind));
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
