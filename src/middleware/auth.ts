import type { Request, RequestHandler } from 'express';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/tokens.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { UserRole } from '@prisma/client';

/**
 * Authentication and role checks.
 *
 * Three levels, matching the "Auth" column in backend-guide/ENDPOINTS.md:
 *
 *   optionalAuth  — public, but the response changes when a token is present
 *                   (a Book carries the caller's shelfStatus, a list its
 *                   isFollowing). No token is not an error.
 *   requireAuth   — a valid token is mandatory.
 *   requireRole   — a valid token with a specific role.
 *
 * Ownership ("the resource must belong to that publisher") is deliberately not
 * here: it needs the resource, so it lives in the service that loaded it.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessTokenPayload;
    }
  }
}

function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (!token) return next();
  try {
    req.auth = verifyAccessToken(token);
  } catch {
    // A malformed or expired token on a public endpoint is treated as no token
    // at all. Rejecting would mean a signed-in user whose access token just
    // expired cannot browse the catalogue until they refresh — worse than
    // serving them the anonymous view for one request.
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (!token) return next(unauthorized('Authentication required'));
  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch (err) {
    next(err);
  }
};

export function requireRole(...roles: UserRole[]): RequestHandler[] {
  return [
    requireAuth,
    (req, _res, next) => {
      if (!req.auth) return next(unauthorized());
      if (!roles.includes(req.auth.role)) {
        return next(forbidden(`This endpoint requires the ${roles.join(' or ')} role`));
      }
      next();
    },
  ];
}

/** The caller's id, for handlers that ran behind `requireAuth`. */
export function userId(req: Request): string {
  if (!req.auth) throw unauthorized();
  return req.auth.sub;
}

/** The caller's id, or null on a public endpoint with no token. */
export function optionalUserId(req: Request): string | null {
  return req.auth?.sub ?? null;
}

/** The publisher a publisher-role caller manages. */
export function publisherId(req: Request): string {
  if (!req.auth) throw unauthorized();
  if (!req.auth.pid) throw forbidden('This account is not linked to a publisher');
  return req.auth.pid;
}
