import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging.
 *
 * Pretty-printed in development, JSON in production so a log shipper can parse
 * it. `redact` is not optional: without it the request logger writes
 * `Authorization: Bearer eyJ…` to disk on every authenticated call, which turns
 * the log file into a credential store.
 */
export const logger = pino({
  level: env.isTest ? 'silent' : env.isProduction ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.newPassword',
      'req.body.currentPassword',
      'req.body.refreshToken',
      'req.body.token',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
  transport: env.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
});
