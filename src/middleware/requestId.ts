import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Attaches `X-Request-Id` to every response (CONVENTIONS.md §8).
 *
 * An inbound id is honoured so a trace started at the mobile client, or at a
 * proxy, survives into the API's logs — that is the whole point of the header:
 * a user reporting "it failed at 14:03" can hand over one id instead of a
 * timestamp to grep for.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200
      ? incoming
      : crypto.randomUUID();

  res.setHeader('X-Request-Id', id);
  res.locals.requestId = id;
  next();
};
