import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * File storage.
 *
 * Without S3 credentials this echoes the URI back with a generated id, which is
 * enough for the app's flows to work end to end in development: the client
 * already holds a local URI it can render, and the server records the reference.
 *
 * For production, upload to S3 here and return the public URL. Presigned
 * direct-to-storage uploads are preferable — this endpoint then only records
 * the result rather than proxying bytes through the API.
 */

export interface StoredFile {
  id: string;
  url: string;
}

export async function storeUpload(uri: string, kind: string): Promise<StoredFile> {
  const id = crypto.randomUUID();

  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY) {
    logger.info({ kind, id }, '[storage:stub] recorded upload without transferring bytes');
    return { id, url: uri };
  }

  // Implement the S3 PUT here. Left explicit rather than half-written: silently
  // returning a URL that points at nothing is worse than an obvious gap.
  throw new Error('S3 is configured but the upload path is not implemented — see src/integrations/storage.ts');
}
