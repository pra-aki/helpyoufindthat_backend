import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { createAccountsService } from '../src/services/accounts.js';

// ---------- the admin call ----------

const supabase = (key) => loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: key }).supabase;
const capture = (status, body = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status }); };
  return { calls, fetchImpl };
};

test('deleteUser calls the auth admin API with the service key, in the header each key format needs', async () => {
  const secret = capture(200);
  assert.deepEqual(await createAccountsService(supabase('sb_secret_abc'), { fetchImpl: secret.fetchImpl }).deleteUser('u-1'), { alreadyGone: false });
  assert.equal(secret.calls[0].url, 'https://abc.supabase.co/auth/v1/admin/users/u-1');
  assert.equal(secret.calls[0].init.method, 'DELETE');
  assert.deepEqual(secret.calls[0].init.headers, { apikey: 'sb_secret_abc' }, 'a secret key goes in apikey only; as a bearer the gateway rejects it');

  const legacy = capture(200);
  await createAccountsService(supabase('eyJhbGciOiJIUzI1NiJ9.x.y'), { fetchImpl: legacy.fetchImpl }).deleteUser('u-1');
  assert.deepEqual(legacy.calls[0].init.headers, { apikey: 'eyJhbGciOiJIUzI1NiJ9.x.y', Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' });
});

test('deleteUser treats a missing user as deleted, and other failures as 502', async () => {
  assert.deepEqual(await createAccountsService(supabase('sb_secret_abc'), { fetchImpl: capture(404).fetchImpl }).deleteUser('gone'), { alreadyGone: true });
  await assert.rejects(createAccountsService(supabase('sb_secret_abc'), { fetchImpl: capture(500, { msg: 'boom' }).fetchImpl }).deleteUser('u'), (e) => e.status === 502 && e.details.reason === 'boom');
  await assert.rejects(createAccountsService(supabase('sb_secret_abc'), { fetchImpl: async () => { throw new Error('ECONNRESET'); } }).deleteUser('u'), (e) => e.status === 502);
  await assert.rejects(createAccountsService(loadConfig({ SUPABASE_URL: 'https://abc.supabase.co' }).supabase, { fetchImpl: capture(200).fetchImpl }).deleteUser('u'), (e) => e.status === 500 && /SUPABASE_SERVICE_ROLE_KEY/.test(e.message));
});

// ---------- the route ----------

const fakeVerify = async (token) => { if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false }; throw new HttpError(401, 'Invalid token'); };
const deleted = [];
const fakeAccounts = { deleteUser: async (id) => { deleted.push(id); return { alreadyGone: false }; } };
let server; let base;
before(async () => {
  server = createApp({ config: loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' }), verify: fakeVerify, accounts: fakeAccounts }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const del = (body, token = 'good') => fetch(`${base}/api/account`, { method: 'DELETE', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

test('DELETE /api/account needs sign-in and an explicit confirmation', async () => {
  deleted.length = 0;
  assert.equal((await del({ confirm: true }, null)).status, 401);
  for (const body of [undefined, {}, { confirm: 'true' }, { confirm: 1 }]) {
    const res = await del(body);
    assert.equal(res.status, 400, `refused without confirm: true (${JSON.stringify(body)})`);
  }
  assert.match((await (await del({})).json()).error.message, /cannot be undone/);
  assert.equal(deleted.length, 0, 'nothing was deleted');
});

test('DELETE /api/account deletes the signed-in user, never one named in the body', async () => {
  deleted.length = 0;
  const res = await del({ confirm: true, userId: 'someone-else' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true });
  assert.deepEqual(deleted, ['user-1']);
});

test('getEmail reads the account\'s current address with the service key', async () => {
  const ok = capture(200, { id: 'u-1', email: 'now@example.com' });
  assert.equal(await createAccountsService(supabase('sb_secret_abc'), { fetchImpl: ok.fetchImpl }).getEmail('u-1'), 'now@example.com');
  assert.equal(ok.calls[0].url, 'https://abc.supabase.co/auth/v1/admin/users/u-1');
  assert.equal(ok.calls[0].init.method, undefined, 'a plain GET');
  assert.deepEqual(ok.calls[0].init.headers, { apikey: 'sb_secret_abc' });
  assert.equal(await createAccountsService(supabase('sb_secret_abc'), { fetchImpl: capture(404).fetchImpl }).getEmail('gone'), null);
  assert.equal(await createAccountsService(supabase('sb_secret_abc'), { fetchImpl: capture(200, { id: 'u', email: '' }).fetchImpl }).getEmail('u'), null);
  await assert.rejects(createAccountsService(supabase('sb_secret_abc'), { fetchImpl: capture(500, { msg: 'boom' }).fetchImpl }).getEmail('u'), (e) => e.status === 502);
});
