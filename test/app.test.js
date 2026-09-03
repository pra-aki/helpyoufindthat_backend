import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ PERPLEXITY_API_KEY: 'test-key' });
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

before(async () => {
  server = createApp({ config, search: fakeSearch }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('GET /health', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /api/forums lists supported forums', async () => {
  const { forums } = await (await fetch(`${base}/api/forums`)).json();
  assert.equal(forums.length, 6);
  assert.ok(forums.some((f) => f.id === 'hackernews'));
});

test('POST /api/threads returns results and echoes resolved query with defaults', async () => {
  const res = await fetch(`${base}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productDescription: 'A tool that finds parking', forum: 'Reddit' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.query, { productDescription: 'A tool that finds parking', forum: 'reddit', threads: 10, days: 1 });
  assert.equal(body.count, 1);
  assert.equal(body.threads[0].title, 'T');
  assert.equal(lastSearchArgs.forum.id, 'reddit');
  assert.equal(lastSearchArgs.threads, 10);
});

test('GET /api/threads accepts query-string parameters including x and y', async () => {
  const qs = new URLSearchParams({ productDescription: 'desc', forum: 'hacknews', x: '4', y: '14' });
  const body = await (await fetch(`${base}/api/threads?${qs}`)).json();
  assert.deepEqual(body.query, { productDescription: 'desc', forum: 'hackernews', threads: 4, days: 14 });
});

test('validation errors come back as 400 JSON', async () => {
  const res = await fetch(`${base}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productDescription: 'desc', forum: 'myspace' }),
  });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error.message, /Unsupported forum/);
  assert.ok(error.details.supported.includes('quora'));
});

test('malformed JSON body is a 400, unknown route is a 404', async () => {
  const bad = await fetch(`${base}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
