import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createSupabaseVerifier } from '../src/auth/supabase.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co/' });
const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const keySet = createLocalJWKSet({ keys: [jwk] });
const { privateKey: otherKey } = await generateKeyPair('ES256');

const sign = (claims = {}, { key = privateKey, exp = '1h' } = {}) =>
  new SignJWT({ email: 'u@example.com', role: 'authenticated', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(claims.iss ?? 'https://abc.supabase.co/auth/v1')
    .setAudience(claims.aud ?? 'authenticated')
    .setSubject(claims.sub ?? 'user-123')
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);

const verify = createSupabaseVerifier(config.supabase, { keySet });

test('config derives issuer and JWKS URL from SUPABASE_URL, trimming trailing slash', () => {
  assert.equal(config.supabase.issuer, 'https://abc.supabase.co/auth/v1');
  assert.equal(config.supabase.jwksUrl, 'https://abc.supabase.co/auth/v1/.well-known/jwks.json');
});

test('accepts a valid Supabase token and returns the user', async () => {
  const user = await verify(await sign());
  assert.deepEqual(user, { id: 'user-123', email: 'u@example.com', role: 'authenticated', isAnonymous: false });
});

test('flags anonymous sessions', async () => {
  const user = await verify(await sign({ is_anonymous: true }));
  assert.equal(user.isAnonymous, true);
});

const rejects = async (token, status, pattern) =>
  assert.rejects(verify(token), (err) => err.status === status && pattern.test(err.message));

test('rejects expired, wrong-issuer, wrong-audience, wrong-key, and garbage tokens with 401', async () => {
  await rejects(await sign({}, { exp: '-1s' }), 401, /expired/);
  await rejects(await sign({ iss: 'https://evil.supabase.co/auth/v1' }), 401, /Invalid/);
  await rejects(await sign({ aud: 'anon' }), 401, /Invalid/);
  await rejects(await sign({}, { key: otherKey }), 401, /Invalid/);
  await rejects('not.a.jwt', 401, /Invalid/);
});

test('fails closed with 500 when SUPABASE_URL is not configured', async () => {
  const unconfigured = createSupabaseVerifier(loadConfig({}).supabase);
  await assert.rejects(unconfigured(await sign()), (err) => err.status === 500 && /SUPABASE_URL/.test(err.message));
});
