import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';

const config = loadConfig({ PERPLEXITY_API_KEY: 'test-key', SUPABASE_URL: 'https://abc.supabase.co', RATE_LIMIT_PER_MINUTE: '3', CORS_ORIGINS: 'https://app.example.com' });
let server;
let base;
let lastSearchArgs;

const fakeSearch = async (args) => {
  lastSearchArgs = args;
  return {
    threads: [{ title: 'T', url: 'https://reddit.com/r/a/comments/abc/t', summary: '', whyRelevant: '', postedAt: null, relevanceScore: 0.8, source: 'reddit' }],
    meta: { model: 'fake' },
  };
};
const fakeVerify = async (token) => {
  if (token === 'good') return { id: 'user-1', email: 'u@example.com', role: 'authenticated', isAnonymous: false };
  if (token === 'anon') return { id: 'user-2', email: null, role: 'authenticated', isAnonymous: true };
  throw new HttpError(401, 'Invalid token');
};
const PID = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
const fakeProducts = { get: async (token, id) => { if (id !== PID) throw new HttpError(404, 'Not found'); return { id, name: 'Parking', description: 'A tool that finds parking' }; }, list: async () => [], create: async () => ({}) };
const fakeResults = { save: async (token, productId, threads, { searchDate }) => threads.map((t, i) => ({ id: `r${i}`, link: t.url, searchDate })), list: async () => ({ results: [], total: 0 }) };
const auth = { authorization: 'Bearer good' };
const post = (body, headers = {}) =>
  fetch(`${base}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  server = createApp({ config, search: fakeSearch, verify: fakeVerify, products: fakeProducts, results: fakeResults }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('GET /health is public', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /api/forums is public', async () => {
  const { forums } = await (await fetch(`${base}/api/forums`)).json();
  assert.equal(forums.length, 6);
});

test('POST /api/threads requires a valid token', async () => {
  const missing = await post({ productId: PID, forum: 'reddit' });
  assert.equal(missing.status, 401);
  assert.match((await missing.json()).error.message, /Authorization/);
  const bad = await post({ productId: PID, forum: 'reddit' }, { authorization: 'Bearer nope' });
  assert.equal(bad.status, 401);
  const anon = await post({ productId: PID, forum: 'reddit' }, { authorization: 'Bearer anon' });
  assert.equal(anon.status, 403);
});

test('POST /api/threads with a valid token searches the product description, stores results, and echoes the query', async () => {
  const res = await post({ productId: PID, forum: 'Reddit' }, auth);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.query.productId, PID);
  assert.equal(body.query.productName, 'Parking');
  assert.equal(body.query.productDescription, 'A tool that finds parking', 'description comes from the product');
  assert.equal(body.saved.count, 1);
  assert.equal(body.threads[0].id, 'r0');
  assert.deepEqual(body.query.forums, ['reddit']);
  assert.equal(body.query.threads, 10);
  assert.equal(body.query.days, 1);
  assert.match(body.query.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(body.query.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(lastSearchArgs.from instanceof Date && lastSearchArgs.to instanceof Date);
  assert.equal(lastSearchArgs.productDescription, 'A tool that finds parking');
  assert.equal(body.count, 1);
  assert.deepEqual(lastSearchArgs.forums.map((f) => f.id), ['reddit']);
  assert.equal(lastSearchArgs.user.id, 'user-1');
});

test('GET /api/threads accepts query-string parameters including x and y', async () => {
  const qs = new URLSearchParams({ productId: PID, forum: 'hacknews', x: '4', y: '14' });
  const res = await fetch(`${base}/api/threads?${qs}`, { headers: auth });
  assert.equal(res.status, 200);
  const q = (await res.json()).query;
  assert.deepEqual([q.forums, q.threads, q.days], [['hackernews'], 4, 14]);
});

test('GET /api/threads accepts an explicit from/to range', async () => {
  const fresh = createApp({ config: loadConfig({ SUPABASE_URL: 'https://abc.supabase.co' }), search: fakeSearch, verify: fakeVerify, products: fakeProducts, results: fakeResults }).listen(0);
  await new Promise((r) => fresh.once('listening', r));
  const qs = new URLSearchParams({ productId: PID, forum: 'reddit', from: '2026-01-01', to: '2026-01-31' });
  const res = await fetch(`http://127.0.0.1:${fresh.address().port}/api/threads?${qs}`, { headers: auth });
  assert.equal(res.status, 200);
  const q = (await res.json()).query;
  assert.deepEqual([q.from, q.to, q.days], ['2026-01-01', '2026-01-31', 30]);
  fresh.close();
});

test('forum accepts a JSON array in POST and a comma list in GET', async () => {
  const fresh = createApp({ config: loadConfig({ SUPABASE_URL: 'https://abc.supabase.co' }), search: fakeSearch, verify: fakeVerify, products: fakeProducts, results: fakeResults }).listen(0);
  await new Promise((r) => fresh.once('listening', r));
  const b = `http://127.0.0.1:${fresh.address().port}`;
  const postRes = await fetch(`${b}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ productId: PID, forum: ['reddit', 'x'] }) });
  assert.deepEqual((await postRes.json()).query.forums, ['reddit', 'x']);
  const getRes = await fetch(`${b}/api/threads?${new URLSearchParams({ productId: PID, forum: 'all' })}`, { headers: auth });
  assert.equal((await getRes.json()).query.forums.length, 6);
  fresh.close();
});

test('rate limit kicks in per user after the configured number of requests', async () => {
  // Two authenticated requests have already been made above by user-1 (rejected ones never reach the limiter).
  const third = await post({ productId: PID, forum: 'reddit' }, auth);
  assert.equal(third.status, 200);
  assert.equal(third.headers.get('x-ratelimit-remaining'), '0');
  const fourth = await post({ productId: PID, forum: 'reddit' }, auth);
  assert.equal(fourth.status, 429);
  assert.ok(fourth.headers.get('retry-after'));
});

test('validation errors come back as 400 JSON (auth runs first, so use a fresh limiter)', async () => {
  const fresh = createApp({ config: loadConfig({ SUPABASE_URL: 'https://abc.supabase.co' }), search: fakeSearch, verify: fakeVerify, products: fakeProducts, results: fakeResults }).listen(0);
  await new Promise((r) => fresh.once('listening', r));
  const b = `http://127.0.0.1:${fresh.address().port}`;
  const send = (body) => fetch(`${b}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) });
  const res = await send({ productId: PID, forum: 'myspace' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Unsupported forum/);
  const noProduct = await send({ forum: 'reddit' });
  assert.equal(noProduct.status, 400);
  assert.match((await noProduct.json()).error.message, /productId/);
  const overridden = await send({ productId: PID, forum: 'reddit', productDescription: 'A different angle' });
  assert.equal((await overridden.json()).query.productDescription, 'A different angle', 'an explicit description overrides the stored one');
  fresh.close();
});

test('CORS: allowed origin is echoed, others are not, and preflight succeeds', async () => {
  const ok = await fetch(`${base}/api/forums`, { headers: { origin: 'https://app.example.com' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.example.com');
  const no = await fetch(`${base}/api/forums`, { headers: { origin: 'https://evil.example.com' } });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(`${base}/api/threads`, { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/i);
  assert.match(pre.headers.get('access-control-allow-methods'), /PATCH/, 'PATCH must be allowed for product edits');
});

test('malformed JSON body is a 400, unknown route is a 404', async () => {
  const bad = await fetch(`${base}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
