import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/middleware/rateLimit.js';

const run = (mw, req) =>
  new Promise((resolve) => {
    const headers = {};
    const res = { set: (k, v) => (headers[k] = v) };
    mw(req, res, (err) => resolve({ err, headers }));
  });

test('allows perMinute requests per key, then 429s until the window slides', async () => {
  let t = 1_000_000;
  const mw = rateLimit({ perMinute: 2, now: () => t });
  const alice = { user: { id: 'alice' } };
  const bob = { user: { id: 'bob' } };

  assert.equal((await run(mw, alice)).err, undefined);
  const second = await run(mw, alice);
  assert.equal(second.err, undefined);
  assert.equal(second.headers['X-RateLimit-Remaining'], '0');

  const third = await run(mw, alice);
  assert.equal(third.err?.status, 429);
  assert.ok(Number(third.headers['Retry-After']) >= 1);

  assert.equal((await run(mw, bob)).err, undefined, 'other users are unaffected');

  t += 61_000;
  assert.equal((await run(mw, alice)).err, undefined, 'window has slid');
  mw.stop();
});

test('falls back to IP when there is no user', async () => {
  const mw = rateLimit({ perMinute: 1 });
  assert.equal((await run(mw, { ip: '1.1.1.1' })).err, undefined);
  assert.equal((await run(mw, { ip: '1.1.1.1' })).err?.status, 429);
  assert.equal((await run(mw, { ip: '2.2.2.2' })).err, undefined);
  mw.stop();
});
