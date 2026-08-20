import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * OCR for the quote scanner.
 *
 * The reader photographs a page, the app extracts the text, and they edit it
 * before posting. Because the result is always reviewed by a human, imperfect
 * recognition is acceptable — returning an error is not, since it dead-ends
 * the flow.
 *
 * Whichever provider is wired in must handle Azerbaijani: ə, ğ, ı, ö, ş, ü, ç.
 * A model trained only on Turkish will silently mangle every `ə`, which is the
 * most common letter in the language.
 */

export interface OcrResult {
  text: string;
  confidence: number;
}

const SAMPLES = [
  'Hər kəs dünyanı dəyişdirmək istəyir, amma heç kim özünü dəyişdirmək istəmir.',
  'Kitablar insanın öz-özü ilə apardığı ən uzun söhbətdir.',
  'Yalnız itirdiyimiz şeylərin əsl qiymətini bilirik, çünki onlar bizi tərk edərkən danışmağa başlayır.',
  'İnsan yalnız ürəyi ilə yaxşı görür. Əsas olan gözlə görünməzdir.',
];

export async function extractText(imageUri: string): Promise<OcrResult> {
  if (env.OCR_PROVIDER === 'stub' || !env.OCR_PROVIDER_KEY) {
    logger.info({ imageUri: imageUri.slice(0, 80) }, '[ocr:stub] returning a sample passage');
    // Chosen from the URI rather than at random, so repeating a request gives
    // the same answer and the flow is demonstrable.
    const index = [...imageUri].reduce((sum, c) => sum + c.charCodeAt(0), 0) % SAMPLES.length;
    return { text: SAMPLES[index]!, confidence: 0.93 };
  }

  // Wire the provider in here. Deliberately unimplemented rather than
  // approximated — a scanner that returns plausible but wrong text is worse
  // than one that is obviously not connected yet.
  throw new Error(
    `OCR_PROVIDER is "${env.OCR_PROVIDER}" but no client is implemented — see src/integrations/ocr.ts`,
  );
}
