import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Outbound email.
 *
 * Without `SMTP_HOST` the reset link is logged instead of sent. That is the
 * right development default: it means a fresh clone can complete the
 * forgot-password flow with no mail account, and the developer can see the
 * token they need without opening an inbox.
 *
 * To send for real, add an SMTP transport here — the call sites do not change.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

async function deliver(message: MailMessage): Promise<void> {
  if (!env.SMTP_HOST) {
    logger.info(
      { to: message.to, subject: message.subject },
      `[mail:stub] ${message.text.replace(/\s+/g, ' ').slice(0, 300)}`,
    );
    return;
  }

  // Wire up nodemailer (or a provider SDK) here. Deliberately left unimplemented
  // rather than half-implemented: a transport that silently fails is worse than
  // one that is obviously absent.
  throw new Error(
    'SMTP_HOST is set but no mail transport is configured — see src/integrations/mail.ts',
  );
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${env.APP_RESET_URL}?token=${encodeURIComponent(token)}`;

  await deliver({
    to,
    subject: 'KitabDostu — şifrənin bərpası',
    text: [
      'Salam,',
      '',
      'Şifrəni yeniləmək üçün bu linkə keç:',
      link,
      '',
      'Link 1 saat ərzində etibarlıdır. Bu sorğunu sən göndərməmisənsə, məktubu nəzərə alma.',
      '',
      'KitabDostu',
    ].join('\n'),
  });
}

export async function sendOrderConfirmationEmail(
  to: string,
  orderCode: string,
  total: number,
): Promise<void> {
  await deliver({
    to,
    subject: `KitabDostu — sifariş ${orderCode}`,
    text: [
      'Sifarişin qəbul olundu.',
      '',
      `Sifariş nömrəsi: ${orderCode}`,
      `Məbləğ: ${total.toFixed(2)} ₼`,
      '',
      'Statusu tətbiqdən izləyə bilərsən.',
    ].join('\n'),
  });
}
