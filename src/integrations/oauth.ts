import { env } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Social sign-in.
 *
 * Each provider hands the mobile app an identity token; the app posts it here
 * and this module verifies it *with the provider* before trusting anything
 * inside. Decoding the JWT without verification would let anyone sign in as
 * anyone by crafting a payload — the token is data from the client, and the
 * client is not trusted.
 *
 * Without the provider's client id configured, verification runs in stub mode
 * and accepts a `stub:<uid>:<email>:<name>` token. That keeps the flow
 * demonstrable on a fresh clone; it is refused outright in production.
 */

export type OAuthProvider = 'google' | 'apple' | 'facebook';

export interface OAuthProfile {
  uid: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export function isSupportedProvider(value: string): value is OAuthProvider {
  return value === 'google' || value === 'apple' || value === 'facebook';
}

function clientIdFor(provider: OAuthProvider): string | undefined {
  switch (provider) {
    case 'google':
      return env.GOOGLE_OAUTH_CLIENT_ID;
    case 'apple':
      return env.APPLE_OAUTH_CLIENT_ID;
    case 'facebook':
      return env.FACEBOOK_OAUTH_APP_ID;
  }
}

export async function verifyOAuthToken(
  provider: OAuthProvider,
  idToken: string,
): Promise<OAuthProfile> {
  const clientId = clientIdFor(provider);

  if (!clientId) {
    if (env.isProduction) {
      throw unauthorized(`${provider} sign-in is not configured on this server`);
    }
    return stubProfile(provider, idToken);
  }

  switch (provider) {
    case 'google':
      return verifyGoogle(idToken, clientId);
    case 'facebook':
      return verifyFacebook(idToken, clientId);
    case 'apple':
      // Apple requires validating the token's signature against Apple's rotating
      // JWKS. Left unimplemented rather than approximated: a half-checked Apple
      // token is an authentication bypass, not a missing feature.
      throw unauthorized('Apple sign-in verification is not implemented yet');
  }
}

/** Google's tokeninfo endpoint verifies the signature and returns the claims. */
async function verifyGoogle(idToken: string, clientId: string): Promise<OAuthProfile> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  );
  if (!res.ok) throw unauthorized('Google token could not be verified');

  const claims = (await res.json()) as {
    aud?: string;
    sub?: string;
    email?: string;
    email_verified?: string | boolean;
    name?: string;
    picture?: string;
  };

  // Without the audience check the endpoint accepts a valid Google token issued
  // for a *different* application, which is a full account takeover.
  if (claims.aud !== clientId) throw unauthorized('Google token was issued for another app');
  if (!claims.sub) throw unauthorized('Google token is missing a subject');

  const verified = claims.email_verified === true || claims.email_verified === 'true';

  return {
    uid: claims.sub,
    // An unverified address must not be trusted for account matching — it would
    // let someone claim an account by registering the same address elsewhere.
    email: verified ? (claims.email ?? null) : null,
    name: claims.name ?? null,
    avatarUrl: claims.picture ?? null,
  };
}

async function verifyFacebook(accessToken: string, appId: string): Promise<OAuthProfile> {
  const debugRes = await fetch(
    `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}` +
      `&access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!debugRes.ok) throw unauthorized('Facebook token could not be verified');

  const debug = (await debugRes.json()) as { data?: { app_id?: string; is_valid?: boolean } };
  if (!debug.data?.is_valid) throw unauthorized('Facebook token is not valid');
  if (debug.data.app_id !== appId) throw unauthorized('Facebook token was issued for another app');

  const profileRes = await fetch(
    `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${encodeURIComponent(accessToken)}`,
  );
  if (!profileRes.ok) throw unauthorized('Facebook profile could not be read');

  const profile = (await profileRes.json()) as {
    id: string;
    name?: string;
    email?: string;
    picture?: { data?: { url?: string } };
  };

  return {
    uid: profile.id,
    email: profile.email ?? null,
    name: profile.name ?? null,
    avatarUrl: profile.picture?.data?.url ?? null,
  };
}

/**
 * Development stand-in: `stub:<uid>:<email>:<name>`.
 *
 *   curl -X POST .../auth/oauth/google -d '{"idToken":"stub:g1:a@b.az:Leyla"}'
 */
function stubProfile(provider: OAuthProvider, idToken: string): OAuthProfile {
  logger.warn(`[oauth:stub] ${provider} verification skipped — no client id configured`);

  const [prefix, uid, email, name] = idToken.split(':');
  if (prefix !== 'stub' || !uid) {
    throw unauthorized(
      `${provider} is not configured. In development, pass a token shaped like stub:<uid>:<email>:<name>`,
    );
  }

  return {
    uid: `${provider}_${uid}`,
    email: email || null,
    name: name || null,
    avatarUrl: null,
  };
}
