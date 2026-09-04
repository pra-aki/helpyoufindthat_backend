import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { HttpError } from '../errors.js';

/**
 * Builds a verifier for Supabase Auth access tokens.
 *
 * Supabase signs access tokens with the project's current signing key and
 * publishes the public half at <SUPABASE_URL>/auth/v1/.well-known/jwks.json.
 * Tokens are verified locally against that key set, so no secret is needed
 * here and a leaked token can only ever act as the user it belongs to.
 *
 * @param {object} supabaseConfig  config.supabase from src/config.js
 * @param {object} [options]
 * @param {Function} [options.keySet]  jose key resolver, injectable for tests
 */
export function createSupabaseVerifier(supabaseConfig, { keySet } = {}) {
  const { issuer, jwksUrl, audience } = supabaseConfig;
  const resolveKey = keySet ?? (jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null);

  return async function verify(token) {
    if (!resolveKey || !issuer) {
      throw new HttpError(500, 'Server is missing SUPABASE_URL; authentication is not configured');
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(token, resolveKey, { issuer, audience }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new HttpError(401, 'Token has expired');
      if (err instanceof joseErrors.JOSEError) throw new HttpError(401, 'Invalid token');
      throw new HttpError(503, 'Could not verify token', { reason: err?.message });
    }
    if (!payload.sub) throw new HttpError(401, 'Invalid token');
    return {
      id: payload.sub,
      email: payload.email ?? null,
      role: payload.role ?? null,
      isAnonymous: payload.is_anonymous === true,
    };
  };
}

const bearerToken = (req) => {
  const header = req.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

/**
 * Express middleware: requires a valid Supabase session token in
 * "Authorization: Bearer <access_token>" and sets req.user.
 */
export function requireUser(verify, { allowAnonymous = false } = {}) {
  return async (req, _res, next) => {
    try {
      const token = bearerToken(req);
      if (!token) throw new HttpError(401, 'Missing Authorization: Bearer <token> header');
      const user = await verify(token);
      if (user.isAnonymous && !allowAnonymous) throw new HttpError(403, 'Anonymous sessions are not allowed');
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
