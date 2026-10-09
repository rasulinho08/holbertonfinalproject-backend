/**
 * Image validation for uploads.
 *
 * The type is decided by the file's magic bytes, never by the `mimeType` the
 * client sends: a file served back with a client-chosen Content-Type is how an
 * "avatar" becomes an HTML page on the API's origin. Only raster formats every
 * client can render are accepted — no SVG (it can carry script) and no HEIC
 * (most browsers cannot display it; the app converts to JPEG before upload).
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export function sniffImageType(bytes: Buffer): ImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    return 'image/gif';
  }
  return null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes the upload body's `data` field. Accepts bare base64 or a `data:`
 * URL (what a web file input produces). Returns null for anything that is not
 * well-formed base64, rather than letting Buffer.from silently skip garbage.
 */
export function decodeBase64Image(data: string): Buffer | null {
  const payload = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  const compact = payload.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}
