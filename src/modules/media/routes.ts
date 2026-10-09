import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, userId } from '../../middleware/auth.js';
import { ocrLimiter, uploadLimiter } from '../../middleware/rateLimit.js';
import { created, ok } from '../../lib/envelope.js';
import { storeUpload } from '../../integrations/storage.js';
import { extractText } from '../../integrations/ocr.js';
import { getImage, saveImage } from './service.js';

/* -------------------------------- uploads --------------------------------- */

export const uploadsRouter: Router = Router();

const KINDS = ['avatar', 'cover', 'review', 'quote', 'publication'] as const;

uploadsRouter.post(
  '/',
  requireAuth,
  uploadLimiter,
  validate(
    z
      .object({
        kind: z.enum(KINDS).default('review'),
        // The image itself, base64-encoded (bare, or as a data: URL). This is
        // the path the app uses: the bytes are stored and served back from
        // GET /uploads/files/:id, so the URL works on every device.
        data: z.string().min(1).max(8_000_000).optional(),
        // Legacy: a URI the client already holds. Kept so app builds that are
        // already installed keep working; the server only records it.
        uri: z.string().min(1).max(2000).optional(),
      })
      .refine((body) => body.data !== undefined || body.uri !== undefined, {
        message: 'Send the image as `data`',
        path: ['data'],
      }),
  ),
  asyncHandler(async (req, res) => {
    if (req.body.data !== undefined) {
      created(res, await saveImage(req, userId(req), req.body.kind, req.body.data));
      return;
    }
    created(res, await storeUpload(req.body.uri, req.body.kind));
  }),
);

/**
 * Serves an uploaded image. Public on purpose — avatars and covers appear on
 * public profiles — but only by unguessable id. A file's bytes never change
 * for a given id, so it can be cached forever.
 */
uploadsRouter.get(
  '/files/:id',
  asyncHandler(async (req, res) => {
    const file = await getImage(req.params.id ?? '');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    res.end(file.data);
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
