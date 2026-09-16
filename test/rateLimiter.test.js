import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { getForum } from '../src/forums/index.js';
import { createRateLimiter } from '../src/services/rateLimiter.js';
import { searchThreads } from '../src/services/perplexity.js';

const frozen = { now: () => 0, sleep: async () => {} };

test('the first call goes at once and each later one waits another interval', async () => {
  const limiter = createRateLimiter({ minIntervalMs: 1200, ...frozen });
  const waits = await Promise.all([1, 2, 3, 4, 5, 6].map(() => limiter.schedule(async ({ waitedMs }) => waitedMs)));
  assert.deepEqual(waits, [0, 1200, 2400, 3600, 4800, 6000], 'six forum calls are released 1.2s apart');
});

test('an interval of 0 turns the queue off', async () => {
  const limiter = createRateLimiter({ minIntervalMs: 0, ...frozen });
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => limiter.schedule(async ({ waitedMs }) => waitedMs))), [0, 0, 0]);
});

test('a call that would wait longer than the cap fails fast and keeps its place free', async () => {
  const limiter = createRateLimiter({ minIntervalMs: 1000, maxWaitMs: 1500, ...frozen });
  assert.equal(await limiter.schedule(async ({ waitedMs }) => waitedMs), 0);
  assert.equal(await limiter.schedule(async ({ waitedMs }) => waitedMs), 1000);
  await assert.rejects(limiter.schedule(async () => 'ran'), (e) => e.status === 429 && /queued/.test(e.message));
  assert.equal(limiter.stats().nextSlotInMs, 2000, 'the rejected call did not use up a slot');
});

test('the wait is real, not just reported', async () => {
  const limiter = createRateLimiter({ minIntervalMs: 40 });
  const startedAt = Date.now();
  const elapsed = await Promise.all([1, 2, 3].map(() => limiter.schedule(async () => Date.now() - startedAt)));
  assert.ok(elapsed[0] < 25, `first call ran immediately, took ${elapsed[0]}ms`);
  assert.ok(elapsed[1] >= 30, `second call waited, took ${elapsed[1]}ms`);
  assert.ok(elapsed[2] >= 70, `third call waited twice, took ${elapsed[2]}ms`);
});

test('stats report the queue depth and when the next slot frees up', async () => {
  const limiter = createRateLimiter({ minIntervalMs: 1000, now: () => 5000, sleep: async () => {} });
  assert.deepEqual(limiter.stats(), { waiting: 0, nextSlotInMs: 0 });
  await limiter.schedule(async () => 'done');
  assert.equal(limiter.stats().nextSlotInMs, 1000);
});

test('config defaults to 1.2 seconds, and an explicit 0 is respected', () => {
  assert.equal(loadConfig({}).perplexity.minIntervalMs, 1200);
  assert.equal(loadConfig({}).perplexity.maxQueueWaitMs, 30_000);
  assert.equal(loadConfig({ PERPLEXITY_MIN_INTERVAL_MS: '0' }).perplexity.minIntervalMs, 0);
  assert.equal(loadConfig({ PERPLEXITY_MIN_INTERVAL_MS: '' }).perplexity.minIntervalMs, 1200, 'an empty value is not 0');
  assert.equal(loadConfig({ PERPLEXITY_MIN_INTERVAL_MS: 'soon' }).perplexity.minIntervalMs, 1200);
});

test('a multi-forum search releases its calls one interval apart and logs the queue time', async () => {
  const config = loadConfig({ PERPLEXITY_API_KEY: 'k', PERPLEXITY_BASE_URL: 'https://pplx.test', PERPLEXITY_MIN_INTERVAL_MS: '30' });
  const sentAt = [];
  const fetchImpl = async () => {
    sentAt.push(Date.now());
    return new Response(JSON.stringify({ model: 'sonar-pro', usage: { total_tokens: 1 }, search_results: [], citations: [], choices: [{ message: { content: JSON.stringify({ problem: 'p', threads: [] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { diagnostics } = await searchThreads({
    productDescription: 'Finds leads', forums: [getForum('reddit'), getForum('hackernews'), getForum('x')], threads: 3,
    from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z'), config, fetchImpl,
  });
  assert.equal(sentAt.length, 3);
  assert.ok(sentAt[1] - sentAt[0] >= 25, `second call left ${sentAt[1] - sentAt[0]}ms after the first`);
  assert.ok(sentAt[2] - sentAt[0] >= 55, `third call left ${sentAt[2] - sentAt[0]}ms after the first`);
  const queued = diagnostics.calls.map((c) => c.queuedMs);
  for (const [i, ms] of queued.entries()) {
    assert.ok(Math.abs(ms - i * 30) <= 5, `call ${i} queued for ${ms}ms, expected about ${i * 30}ms`);
  }
});
