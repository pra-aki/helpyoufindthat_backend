import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { parseErrorReport } from '../src/validation.js';

// ---------- validation ----------

test('parseErrorReport needs a message and caps everything else', () => {
  assert.deepEqual(parseErrorReport({ message: '  Search spun forever ', page: '/dashboard', error: 'HTTP 502', details: { status: 502 } }), { message: 'Search spun forever', page: '/dashboard', error: 'HTTP 502', details: { status: 502 } });
  assert.deepEqual(parseErrorReport({ description: 'x', url: '/a', errorMessage: 'e', context: { a: 1 } }), { message: 'x', page: '/a', error: 'e', details: { a: 1 } }, 'accepts the alternate spellings');
  assert.deepEqual(parseErrorReport({ message: 'x', page: '' }), { message: 'x', page: null, error: null, details: null });
  const bad = (body, re) => assert.throws(() => parseErrorReport(body), (e) => e.status === 400 && re.test(e.message), `expected ${re}`);
  bad({}, /message/);
  bad({ message: '   ' }, /message/);
  bad({ message: 'x'.repeat(2001) }, /at most 2000/);
  bad({ message: 'x', page: 'p'.repeat(501) }, /page/);
  bad({ message: 'x', error: 42 }, /error/);
  bad({ message: 'x', details: 'text' }, /details/);
  bad({ message: 'x', details: [1, 2] }, /details/);
  bad({ message: 'x', details: { blob: 'y'.repeat(8000) } }, /8000/);
  bad(null, /JSON object/);
});

// ---------- route ----------

const config = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', ERROR_REPORTS_PER_MINUTE: '3' });
const fakeVerify = async (token) => {
  if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false };
  if (token === 'other') return { id: 'user-2', email: 'o@e.com', role: 'authenticated', isAnonymous: false };
  throw new HttpError(401, 'Invalid token');
};
const inserts = [];
const fakeDb = { insert: async (token, table, row) => { inserts.push([token, table, row]); return { id: `rep${inserts.length}`, created_at: '2026-10-16T12:00:00Z', ...row }; } };
const listen = async (app) => { const s = app.listen(0); await new Promise((r) => s.once('listening', r)); return s; };
let server; let base;
before(async () => { server = await listen(createApp({ config, verify: fakeVerify, db: fakeDb })); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const send = (body, token = 'good', b = base) => fetch(`${b}/api/error-reports`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TestBrowser/1.0', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test('a report is stored with the service key, the verified user, and the browser', async () => {
  inserts.length = 0;
  const res = await send({ message: 'Job page is blank', page: '/dashboard/jobs/1', error: 'Cannot read properties of undefined', details: { status: 500 }, user_id: 'someone-else' });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { report: { id: 'rep1', createdAt: '2026-10-16T12:00:00Z' } });
  assert.deepEqual(inserts[0], ['service', 'error_reports', {
    user_id: 'user-1', message: 'Job page is blank', page: '/dashboard/jobs/1', error: 'Cannot read properties of undefined', details: { status: 500 }, user_agent: 'TestBrowser/1.0',
  }], 'the user comes from the token, never from the body');
});

test('reports need sign-in and a message, and bad ones are never stored', async () => {
  inserts.length = 0;
  assert.equal((await send({ message: 'x' }, null)).status, 401);
  assert.equal((await send({ message: 'x' }, 'bogus')).status, 401);
  assert.equal((await send({ page: '/a' }, 'other')).status, 400);
  assert.equal(inserts.length, 0);
});

test('each user may send only a few reports a minute', async () => {
  const s = await listen(createApp({ config, verify: fakeVerify, db: fakeDb }));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await send({ message: `r${i}` }, 'good', b)).status, 201);
    const limited = await send({ message: 'one too many' }, 'good', b);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    assert.equal((await send({ message: 'another user is unaffected' }, 'other', b)).status, 201);
  } finally {
    s.close();
  }
});

test('without the service key a report fails clearly instead of being dropped', async () => {
  const s = await listen(createApp({ config: loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' }), verify: fakeVerify, db: fakeDb }));
  try {
    const res = await send({ message: 'x' }, 'good', `http://127.0.0.1:${s.address().port}`);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error.message, /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    s.close();
  }
});
