import type { Request } from 'express';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError, notFound } from '../../lib/errors.js';
import { decodeBase64Image, MAX_IMAGE_BYTES, sniffImageType } from './images.js';

export type UploadKind = 'avatar' | 'cover' | 'review' | 'quote' | 'publication';

export interface StoredImage {
  id: string;
  url: string;
}

const FILES_PATH = '/api/v1/uploads/files/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The absolute origin the API is reachable at, for building image URLs the
 * app can load from anywhere. PUBLIC_API_URL wins; Render sets
 * RENDER_EXTERNAL_URL on its own; otherwise the request's own origin (correct
 * behind Render's proxy because `trust proxy` is set in app.ts).
 */
function publicOrigin(req: Request): string {
  const configured = env.PUBLIC_API_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

export async function saveImage(
  req: Request,
  ownerId: string,
  kind: UploadKind,
  data: string,
): Promise<StoredImage> {
  const bytes = decodeBase64Image(data);
  if (!bytes) {
    throw new ApiError('VALIDATION_ERROR', 'Image data is not valid base64', {
      data: 'Image data is not valid base64',
    });
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError('VALIDATION_ERROR', 'Image is larger than 5 MB', {
      data: 'Image is larger than 5 MB',
    });
  }
  const mimeType = sniffImageType(bytes);
  if (!mimeType) {
    throw new ApiError('VALIDATION_ERROR', 'Only JPEG, PNG, WebP and GIF images are accepted', {
      data: 'Only JPEG, PNG, WebP and GIF images are accepted',
    });
  }

  const file = await prisma.mediaFile.create({
    data: { ownerId, kind, mimeType, size: bytes.length, data: new Uint8Array(bytes) },
    select: { id: true },
  });

  return { id: file.id, url: `${publicOrigin(req)}${FILES_PATH}${file.id}` };
}

export async function getImage(id: string): Promise<{ mimeType: string; data: Buffer }> {
  if (!UUID.test(id)) throw notFound('File');
  const file = await prisma.mediaFile.findUnique({
    where: { id },
    select: { mimeType: true, data: true },
  });
  if (!file) throw notFound('File');
  return { mimeType: file.mimeType, data: Buffer.from(file.data) };
}

/** The id of a file this API serves, if `url` points at one. */
export function mediaIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const at = url.indexOf(FILES_PATH);
  if (at === -1) return null;
  const id = url.slice(at + FILES_PATH.length).split(/[?#]/)[0] ?? '';
  return UUID.test(id) ? id : null;
}

/**
 * Deletes the stored file behind a URL that is being replaced — the old avatar
 * after a new one is saved, say — so abandoned images do not accumulate. Only
 * files owned by `ownerId` are touched.
 */
export async function releaseMediaUrl(url: string | null | undefined, ownerId: string): Promise<void> {
  const id = mediaIdFromUrl(url);
  if (!id) return;
  await prisma.mediaFile.deleteMany({ where: { id, ownerId } });
}

/** Account deletion: a deleted reader's photos must stop being reachable. */
export async function deleteMediaOwnedBy(ownerId: string): Promise<void> {
  await prisma.mediaFile.deleteMany({ where: { ownerId } });
}
