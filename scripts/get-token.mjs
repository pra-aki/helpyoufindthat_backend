#!/usr/bin/env node
/**
 * Prints a Supabase access token for a test user, for calling the API by hand
 * before the front end has sign-in wired up.
 *
 *   node --env-file=.env scripts/get-token.mjs you@example.com 'your-password'
 *   node --env-file=.env scripts/get-token.mjs you@example.com 'your-password' --signup   # create the user first
 *
 * Needs SUPABASE_URL and SUPABASE_ANON_KEY in the environment. The anon key is
 * the project's public client key, not a secret.
 */
const [email, password, ...flags] = process.argv.slice(2);
const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

if (!email || !password) {
  console.error('usage: get-token.mjs <email> <password> [--signup]');
  process.exit(2);
}
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set (see Configuration in the README)');
  process.exit(2);
}

const call = async (path, body) => {
  const res = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} failed with HTTP ${res.status}: ${data.msg ?? data.error_description ?? data.message ?? JSON.stringify(data)}`);
  return data;
};

try {
  if (flags.includes('--signup')) {
    const signup = await call('signup', { email, password });
    if (!signup.access_token) {
      console.error('User created but no session returned. If email confirmation is on, confirm the address in the Supabase dashboard (Authentication > Users), then rerun without --signup.');
      process.exit(1);
    }
  }
  const session = await call('token?grant_type=password', { email, password });
  console.error(`user ${session.user.id} (${session.user.email}), token expires in ${session.expires_in}s`);
  console.log(session.access_token);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
