import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { readLimiter, writeLimiter } from './middleware/rateLimit.js';
import { apiRouter } from './modules/index.js';

/**
 * The Express application.
 *
 * Kept separate from `index.ts` so tests can mount it with Supertest without
 * binding a port.
 */
export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy `req.ip` is the proxy's address unless this is set,
  // which would make every per-IP rate limit a single shared bucket.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);

  app.use(
    helmet({
      // The API serves JSON to a native client and to Expo web; the default
      // CSP has no content to protect here and blocks nothing useful.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: a native app, curl, or a same-origin request.
        // Browsers always send one, so this is not a CORS bypass.
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        // A phone on the LAN reaches the API by IP and browsers send that as
        // the origin, so allow private ranges in development rather than
        // making every developer edit CORS_ORIGINS for their own address.
        if (!env.isProduction && /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin)) {
          return callback(null, true);
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept-Language', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (!env.isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (_req, res) => String(res.getHeader('X-Request-Id')),
        autoLogging: { ignore: (req) => req.url === '/health' },
      }),
    );
  }

  // Liveness probe. Outside /api/v1 on purpose — an orchestrator should not
  // need to know the API version to know whether the process is alive.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Broad limits at the edge; specific endpoints tighten them further.
  app.use('/api/v1', (req, res, next) =>
    (req.method === 'GET' ? readLimiter : writeLimiter)(req, res, next),
  );

  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
