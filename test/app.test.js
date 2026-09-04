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
const auth = { authorization: 'Bearer good' };
const post = (body, headers = {}) =>
  fetch(`${base}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  server = createApp({ config, search: fakeSearch, verify: fakeVerify }).listen(0);
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
  const missing = await post({ productDescription: 'desc', forum: 'reddit' });
  assert.equal(missing.status, 401);
  assert.match((await missing.json()).error.message, /Authorization/);
  const bad = await post({ productDescription: 'desc', forum: 'reddit' }, { authorization: 'Bearer nope' });
  assert.equal(bad.status, 401);
  const anon = await post({ productDescription: 'desc', forum: 'reddit' }, { authorization: 'Bearer anon' });
  assert.equal(anon.status, 403);
});

test('POST /api/threads with a valid token returns results, echoes defaults, and passes the user to search', async () => {
  const res = await post({ productDescription: 'A tool that finds parking', forum: 'Reddit' }, auth);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.query, { productDescription: 'A tool that finds parking', forum: 'reddit', threads: 10, days: 1 });
  assert.equal(body.count, 1);
  assert.equal(lastSearchArgs.forum.id, 'reddit');
  assert.equal(lastSearchArgs.user.id, 'user-1');
});

test('GET /api/threads accepts query-string parameters including x and y', async () => {
  const qs = new URLSearchParams({ productDescription: 'desc', forum: 'hacknews', x: '4', y: '14' });
  const res = await fetch(`${base}/api/threads?${qs}`, { headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).query, { productDescription: 'desc', forum: 'hackernews', threads: 4, days: 14 });
});

test('rate limit kicks in per user after the configured number of requests', async () => {
  // Two authenticated requests have already been made above by user-1 (rejected ones never reach the limiter).
  const third = await post({ productDescription: 'desc', forum: 'reddit' }, auth);
  assert.equal(third.status, 200);
  assert.equal(third.headers.get('x-ratelimit-remaining'), '0');
  const fourth = await post({ productDescription: 'desc', forum: 'reddit' }, auth);
  assert.equal(fourth.status, 429);
  assert.ok(fourth.headers.get('retry-after'));
});

test('validation errors come back as 400 JSON (auth runs first, so use a fresh limiter)', async () => {
  const fresh = createApp({ config: loadConfig({ SUPABASE_URL: 'https://abc.supabase.co' }), search: fakeSearch, verify: fakeVerify }).listen(0);
  await new Promise((r) => fresh.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${fresh.address().port}/api/threads`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ productDescription: 'desc', forum: 'myspace' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Unsupported forum/);
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
});

test('malformed JSON body is a 400, unknown route is a 404', async () => {
  const bad = await fetch(`${base}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
