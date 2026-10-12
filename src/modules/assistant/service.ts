import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * The in-app book assistant: a plain chat with Google Gemini.
 *
 * Deliberately simple: no tools, no database access. The app sends the
 * conversation so far, and this returns the next reply. The API key lives
 * only on the server. Without one, the assistant reports itself unavailable
 * rather than inventing answers.
 */

const SYSTEM_PROMPT = `Sən KitabDostu tətbiqinin kitab köməkçisisən. KitabDostu Azərbaycanda kitabsevərlər üçün sosial şəbəkə və kitab mağazasıdır: oxucular rəflər saxlayır, rəy və sitat paylaşır, kitab alır.

Oxuculara kitab seçməkdə, oxuduqları kitabları anlamaqda və müzakirə etməkdə, oxu vərdişi qurmaqda kömək et. İstifadəçi hansı dildə yazırsa, o dildə cavab ver (adətən Azərbaycan dilində). Cavabları qısa və mobil ekranda rahat oxunan saxla.

Kitab tövsiyə edəndə yalnız həqiqətən mövcud olduğunu bildiyin kitabları və müəllifləri adlandır. Bir kitabın KitabDostu kataloqunda olub-olmadığını və ya qiymətini bilmirsən, bunu iddia etmə. Kitabla bağlı olmayan suallara qısa cavab ver və söhbəti nəzakətlə kitablara qaytar.`;

const DECLINED = 'Bağışlayın, bu suala cavab verə bilmirəm. Kitablarla bağlı başqa bir sual verin.';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AssistantReply =
  | { available: true; reply: string }
  | { available: false; reply: null };

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export function isAssistantAvailable(): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

export async function chat(history: ChatTurn[], readerName: string): Promise<AssistantReply> {
  if (!isAssistantAvailable()) return { available: false, reply: null };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    env.GEMINI_MODEL,
  )}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Sent as a header rather than in the URL so it never lands in logs.
      'x-goog-api-key': env.GEMINI_API_KEY!,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\nOxucunun adı: ${readerName}.` }] },
      // Gemini calls the assistant side "model".
      contents: history.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      })),
      generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // The body can echo the request; log only the status.
    logger.error({ status: res.status, model: env.GEMINI_MODEL }, '[assistant] Gemini request failed');
    throw new Error(`Gemini responded ${res.status}`);
  }

  const data = (await res.json()) as GeminiResponse;
  if (data.promptFeedback?.blockReason) return { available: true, reply: DECLINED };

  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === 'SAFETY') return { available: true, reply: DECLINED };

  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  return { available: true, reply: text || 'Bağışlayın, cavab hazırlaya bilmədim. Yenidən cəhd edin.' };
}
