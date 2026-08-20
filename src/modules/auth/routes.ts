import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, requireAuth, userId } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { created, noContent, ok } from '../../lib/envelope.js';
import { badRequest } from '../../lib/errors.js';
import { revokeAllUserTokens, revokeRefreshToken } from '../../lib/tokens.js';
import { isSupportedProvider } from '../../integrations/oauth.js';
import * as service from './service.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  oauthSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  twoFactorDisableSchema,
  twoFactorVerifySchema,
} from './schemas.js';

export const authRouter: Router = Router();

/** User agent and IP, recorded against each refresh token so a reader can see
 *  their sessions and a stolen token can be traced to where it was used. */
const sessionContext = (req: { headers: Record<string, unknown>; ip?: string | undefined }) => ({
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  ip: req.ip,
});

authRouter.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.register(req.body, sessionContext(req)));
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.login(req.body, sessionContext(req)));
  }),
);

authRouter.post(
  '/oauth/:provider',
  authLimiter,
  validate(oauthSchema),
  asyncHandler(async (req, res) => {
    const provider = req.params.provider ?? '';
    if (!isSupportedProvider(provider)) {
      throw badRequest(`Unsupported provider: ${provider}`, { provider: 'unsupported' });
    }
    ok(res, await service.oauthLogin(provider, req.body, sessionContext(req)));
  }),
);

authRouter.post(
  '/refresh',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.refresh(req.body.refreshToken, sessionContext(req)));
  }),
);

/**
 * Sign out.
 *
 * Deliberately **not** behind `requireAuth`. Demanding a valid access token to
 * discard credentials is a contradiction, and it produced a real loop: the app
 * calls logout when it sees a 401, logout answered 401 because the token was
 * already dead, the app saw another 401 and called logout again — until the
 * auth rate limit tripped and even signing back in returned 429.
 *
 * Always 204. Revoking a token that is already revoked, or absent, is a no-op.
 */
authRouter.post(
  '/logout',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null;
    if (token) await revokeRefreshToken(token);
    // With no refresh token to identify the session, revoke every session for
    // the caller if the access token is still readable — otherwise there is
    // nothing to act on, and the client only needs the acknowledgement.
    else if (req.auth) await revokeAllUserTokens(req.auth.sub);
    noContent(res);
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    await service.forgotPassword(req.body.email);
    // Always 200, even for an unknown address — see the service comment.
    ok(res, { sent: true });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    await service.resetPassword(req.body.token, req.body.password);
    ok(res, { success: true });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    await service.changePassword(userId(req), req.body.currentPassword, req.body.newPassword);
    ok(res, { success: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.currentUser(userId(req)));
  }),
);

/* ----------------------------------- 2FA ---------------------------------- */

authRouter.post(
  '/2fa/enable',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.beginTwoFactor(userId(req)));
  }),
);

authRouter.post(
  '/2fa/verify',
  requireAuth,
  validate(twoFactorVerifySchema),
  asyncHandler(async (req, res) => {
    await service.confirmTwoFactor(userId(req), req.body.code);
    ok(res, { enabled: true });
  }),
);

authRouter.post(
  '/2fa/disable',
  requireAuth,
  validate(twoFactorDisableSchema),
  asyncHandler(async (req, res) => {
    await service.disableTwoFactor(userId(req), req.body.password);
    ok(res, { enabled: false });
  }),
);
