import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError, PerplexityError } from '../src/errors.js';
import { createSupabaseRest } from '../src/services/supabaseRest.js';
import { createCreditsService, searchCost, searchCostPerForum, jobRunCost } from '../src/services/credits.js';

// ---------- pricing ----------

test('a search costs one credit per 10 leads requested, rounded up, for each forum', () => {
  assert.equal(searchCost({ threads: 10, forumCount: 1 }), 1);
  assert.equal(searchCost({ threads: 1, forumCount: 1 }), 1, 'a partial ten still costs a credit');
  assert.equal(searchCost({ threads: 11, forumCount: 2 }), 4);
  assert.equal(searchCost({ threads: 50, forumCount: 6 }), 30);
  assert.equal(searchCostPerForum({ threads: 25 }), 3);
});

test('a scheduled run costs one credit per forum, whatever its lead count', () => {
  assert.equal(jobRunCost({ forumCount: 1 }), 1);
  assert.equal(jobRunCost({ forumCount: 6 }), 6);
});

// ---------- database calls ----------

const supabase = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' }).supabase;

test('rpc posts the arguments to the function endpoint', async () => {
  let captured;
  const db = createSupabaseRest(supabase, { fetchImpl: async (url, init) => { captured = { url: String(url), init }; return new Response(JSON.stringify({ charged: true, balance: 7 }), { status: 200 }); } });
  assert.deepEqual(await db.rpc('sb_secret_abc', 'spend_credits', { p_user: 'u1', p_amount: 3 }), { charged: true, balance: 7 });
  assert.equal(captured.url, 'https://abc.supabase.co/rest/v1/rpc/spend_credits');
  assert.equal(captured.init.method, 'POST');
  assert.deepEqual(JSON.parse(captured.init.body), { p_user: 'u1', p_amount: 3 });
  assert.equal(captured.init.headers.apikey, 'sb_secret_abc');
});

test('the credits service changes credits only with the service key, and reads history as the user', async () => {
  const calls = [];
  const db = {
    rpc: async (token, fn, args) => { calls.push([token, fn, args]); return fn === 'spend_credits' ? { charged: false, balance: 2 } : 42; },
    selectPage: async (token, table, query) => { calls.push([token, table, query]); return { rows: [{ id: 't1', user_id: 'u1', delta: -3, balance_after: 97, reason: 'search', details: { forums: ['reddit'] }, created_at: 'c' }], total: 9 }; },
  };
  const credits = createCreditsService(db, { serviceToken: 'service' });
  assert.deepEqual(await credits.spend('u1', 3, 'search', { productId: 'p' }), { charged: false, balance: 2 });
  assert.equal(await credits.refund('u1', 3, { why: 'x' }), 42);
  assert.equal(await credits.balance('u1'), 42);
  assert.deepEqual(calls.slice(0, 3), [
    ['service', 'spend_credits', { p_user: 'u1', p_amount: 3, p_reason: 'search', p_details: { productId: 'p' } }],
    ['service', 'refund_credits', { p_user: 'u1', p_amount: 3, p_details: { why: 'x' } }],
    ['service', 'ensure_user_credits', { p_user: 'u1' }],
  ]);
  const { transactions, total } = await credits.history('user-token', { limit: 5, offset: 10 });
  assert.deepEqual(calls[3], ['user-token', 'credit_transactions', { select: '*', order: 'created_at.desc', limit: '5', offset: '10' }], 'history is read with the user token, so row-level security scopes it');
  assert.deepEqual([transactions[0], total], [{ id: 't1', delta: -3, balanceAfter: 97, reason: 'search', details: { forums: ['reddit'] }, createdAt: 'c' }, 9]);

  const keyless = createCreditsService({ rpc: async () => { throw new Error('should not be called'); } }, { serviceToken: '' });
  await assert.rejects(keyless.spend('u1', 1, 'search'), (e) => e.status === 500 && /SUPABASE_SERVICE_ROLE_KEY/.test(e.message), 'without the key, searches fail closed rather than run free');
});

// ---------- the search route ----------

const PID = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
const config = loadConfig({ PERPLEXITY_MIN_INTERVAL_MS: '0', PERPLEXITY_API_KEY: 'k', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon', RATE_LIMIT_PER_MINUTE: '1000' });
const fakeVerify = async (token) => { if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false }; throw new HttpError(401, 'Invalid token'); };
const fakeProducts = { get: async (tok, id) => { if (id !== PID) throw new HttpError(404, 'Not found'); return { id, name: 'P', description: 'Finds leads' }; } };
const fakeResults = { save: async (tok, pid, threads) => threads.map((t, i) => ({ id: `r${i}`, link: t.url, isNew: true })) };

// An in-memory ledger that behaves like the database functions: it never overdraws.
const events = [];
const ledger = { balance: 100 };
const fakeCredits = {
  spend: async (userId, amount, reason, details) => {
    events.push(['spend', userId, amount, reason, details]);
    if (ledger.balance < amount) return { charged: false, balance: ledger.balance };
    ledger.balance -= amount;
    return { charged: true, balance: ledger.balance };
  },
  refund: async (userId, amount, details) => {
    events.push(['refund', userId, amount, details]);
    if (ledger.failRefunds) throw new Error('db down');
    ledger.balance += amount;
    return ledger.balance;
  },
  balance: async (userId) => { events.push(['balance', userId]); return ledger.balance; },
  history: async (token, page) => { events.push(['history', token, page]); return { transactions: [{ id: 't1', delta: -1, balanceAfter: 99, reason: 'search', details: null, createdAt: 'c' }], total: 1 }; },
};
let searchImpl;
const search = async (args) => { events.push(['search', args.forums.map((f) => f.id), args.threads]); return searchImpl(args); };
const ok = (over = {}) => ({ threads: [{ url: 'https://www.reddit.com/r/a/comments/k1/x/', title: 'T', relevanceScore: 0.9, source: 'reddit' }], meta: {}, diagnostics: {}, ...over });

let server; let base;
before(async () => {
  server = createApp({ config, verify: fakeVerify, products: fakeProducts, results: fakeResults, searchLog: { record: async () => true }, credits: fakeCredits, search }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const post = (body) => fetch(`${base}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer good' }, body: JSON.stringify(body) });
const reset = (balance, extra = {}) => { events.length = 0; Object.assign(ledger, { balance, failRefunds: false, ...extra }); };

test('a search is charged before it runs, one credit per 10 leads per forum, and reports the balance', async () => {
  reset(100);
  searchImpl = async () => ok();
  const res = await post({ productId: PID, forum: ['reddit', 'hackernews'], threads: 15 });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).credits, { spent: 4, refunded: 0, balance: 96 });
  assert.deepEqual(events.map((e) => e[0]), ['spend', 'search'], 'paid for before Perplexity is called');
  assert.deepEqual(events[0], ['spend', 'user-1', 4, 'search', { productId: PID, forums: ['reddit', 'hackernews'], threads: 15 }], 'charged to the verified user, never to an id from the request');
});

test('without enough credits the search is refused with 402 and Perplexity is never called', async () => {
  reset(3);
  searchImpl = async () => { throw new Error('should not search'); };
  const res = await post({ productId: PID, forum: 'all', threads: 10 });
  assert.equal(res.status, 402);
  const { error } = await res.json();
  assert.match(error.message, /costs 6 and you have 3/);
  assert.deepEqual(error.details, { cost: 6, balance: 3 });
  assert.ok(!events.some((e) => e[0] === 'search'));
  assert.equal(ledger.balance, 3, 'nothing was taken');
});

test('bad input and unknown products cost nothing', async () => {
  reset(100);
  assert.equal((await post({ productId: PID, forum: 'myspace' })).status, 400);
  assert.equal((await post({ productId: 'b1e90fbd-9ddf-4c0e-a953-616a94d4891c', forum: 'reddit' })).status, 404);
  assert.equal(events.length, 0);
});

test('a search that fails is refunded in full', async () => {
  reset(100);
  searchImpl = async () => { throw new PerplexityError('Perplexity request failed with HTTP 500', { status: 502 }); };
  const res = await post({ productId: PID, forum: ['reddit', 'x'], threads: 20 });
  assert.equal(res.status, 502);
  assert.deepEqual(events.filter((e) => e[0] !== 'search').map((e) => [e[0], e[2]]), [['spend', 4], ['refund', 4]]);
  assert.equal(ledger.balance, 100);
});

test('a forum whose call failed is refunded its share', async () => {
  reset(100);
  searchImpl = async () => ok({ meta: { failedForums: [{ forum: 'x', error: 'boom', status: 502 }] } });
  const res = await post({ productId: PID, forum: ['reddit', 'x'], threads: 20 });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).credits, { spent: 2, refunded: 2, balance: 98 });
  const refund = events.find((e) => e[0] === 'refund');
  assert.deepEqual([refund[2], refund[3].forums], [2, ['x']]);
});

test('a refund that fails is logged and does not change the response', async () => {
  reset(100, { failRefunds: true });
  searchImpl = async () => { throw new PerplexityError('Perplexity request failed with HTTP 500', { status: 502 }); };
  const quiet = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const res = await post({ productId: PID, forum: 'reddit' });
    assert.equal(res.status, 502, 'the caller still gets the search error, not a refund error');
  } finally {
    console.error = quiet;
  }
  assert.ok(logged.some((l) => /credit refund of 1 for user user-1 failed: db down/.test(l)));
});

test('GET /api/credits returns the balance, the pricing, and the caller\'s ledger', async () => {
  reset(57);
  const res = await fetch(`${base}/api/credits?limit=5`, { headers: { authorization: 'Bearer good' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.balance, 57);
  assert.deepEqual(body.pricing, { signupCredits: 100, leadsPerCredit: 10, jobRunCreditsPerForum: 1 });
  assert.deepEqual([body.count, body.total, body.limit, body.offset], [1, 1, 5, 0]);
  assert.deepEqual(events, [['balance', 'user-1'], ['history', 'good', { limit: 5, offset: 0 }]]);
  assert.equal((await fetch(`${base}/api/credits`)).status, 401);
  assert.equal((await fetch(`${base}/api/credits?limit=500`, { headers: { authorization: 'Bearer good' } })).status, 400);
});
