import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { createSettingsService, DEFAULT_SETTINGS } from '../src/services/settings.js';
import { parseSettingsUpdate } from '../src/routes/settings.js';

// ---------- the service ----------

test('settings default to job emails on until the user saves otherwise', async () => {
  const calls = [];
  const db = {
    select: async (token, table, query) => { calls.push(['select', token, table, query]); return token === 'saved' ? [{ user_id: 'u1', job_lead_emails: false }] : []; },
    upsert: async (token, table, rows, opts) => { calls.push(['upsert', token, table, rows, opts]); return rows.map((r) => ({ job_lead_emails: true, ...r })); },
  };
  const svc = createSettingsService(db);
  assert.deepEqual(DEFAULT_SETTINGS, { jobLeadEmails: true });
  assert.deepEqual(await svc.get('fresh'), { jobLeadEmails: true }, 'no row means the defaults');
  assert.deepEqual(await svc.get('saved'), { jobLeadEmails: false });
  assert.deepEqual(calls[0], ['select', 'fresh', 'user_settings', { select: '*', limit: '1' }], 'read with the caller token, so row-level security scopes it');

  assert.deepEqual(await svc.update('tok', 'u1', { jobLeadEmails: false }), { jobLeadEmails: false });
  assert.deepEqual(calls.at(-1), ['upsert', 'tok', 'user_settings', [{ user_id: 'u1', job_lead_emails: false }], { onConflict: 'user_id' }], 'saved as the user, keyed on their id');

  assert.equal(await svc.jobLeadEmailsEnabled('saved', 'u1'), false);
  assert.deepEqual(calls.at(-1), ['select', 'saved', 'user_settings', { select: 'job_lead_emails', user_id: 'eq.u1', limit: '1' }]);
  assert.equal(await svc.jobLeadEmailsEnabled('service', 'u2'), true, 'a user who never saved settings gets job emails');
});

test('parseSettingsUpdate takes known settings as booleans, and refuses anything else', () => {
  assert.deepEqual(parseSettingsUpdate({ jobLeadEmails: false }), { jobLeadEmails: false });
  const bad = (body, re) => assert.throws(() => parseSettingsUpdate(body), (e) => e.status === 400 && re.test(e.message), `expected ${re}`);
  bad({}, /at least one setting/);
  bad({ jobLeadEmails: 'false' }, /true or false/);
  bad({ jobLeadEmails: 0 }, /true or false/);
  bad({ marketingEmails: false }, /Unknown setting "marketingEmails"/);
  bad({ jobLeadEmails: true, user_id: 'someone-else' }, /Unknown setting "user_id"/);
  bad(null, /JSON object/);
  bad([true], /JSON object/);
});

// ---------- the routes ----------

const fakeVerify = async (token) => { if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false }; throw new HttpError(401, 'Invalid token'); };
const saved = [];
let stored = { jobLeadEmails: true };
const fakeSettings = {
  get: async (token) => { saved.push(['get', token]); return stored; },
  update: async (token, userId, change) => { saved.push(['update', token, userId, change]); stored = { ...stored, ...change }; return stored; },
};
let server; let base;
before(async () => {
  server = createApp({ config: loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' }), verify: fakeVerify, settings: fakeSettings }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const auth = { authorization: 'Bearer good', 'content-type': 'application/json' };

test('GET and PATCH /api/settings read and change the signed-in user\'s settings', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/settings`, { headers: auth })).json(), { settings: { jobLeadEmails: true } });
  const res = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: auth, body: JSON.stringify({ jobLeadEmails: false }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { settings: { jobLeadEmails: false } });
  assert.deepEqual(saved.at(-1), ['update', 'good', 'user-1', { jobLeadEmails: false }], 'saved for the token\'s user');
});

test('settings need sign-in, and bad changes are refused before anything is saved', async () => {
  const before = saved.length;
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"jobLeadEmails":false}' })).status, 401);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'PATCH', headers: auth, body: '{"jobLeadEmails":"no"}' })).status, 400);
  assert.equal(saved.length, before);
});
