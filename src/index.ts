import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

/**
 * Server bootstrap.
 *
 * Binds 0.0.0.0 rather than localhost so a phone on the same Wi-Fi can reach
 * the API — bound to 127.0.0.1 the server accepts connections only from the
 * machine it runs on, which is the single most common reason a device build
 * "cannot connect to the backend".
 */

const app = createApp();

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`KitabDostu API listening on http://localhost:${env.PORT}/api/v1`);
  if (!env.isProduction) {
    logger.info('On a phone, use http://<your-LAN-IP>:%d/api/v1 — see SETUP.md', env.PORT);
  }
});

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * then close the pool. Without this, a deploy can cut a checkout in half
 * between the stock decrement and the order insert.
 */
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);

  const forced = setTimeout(() => {
    logger.error('Shutdown timed out after 10s, exiting');
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(async () => {
    await prisma.$disconnect();
    clearTimeout(forced);
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
