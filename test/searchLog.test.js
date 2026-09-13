import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError, PerplexityError } from '../src/errors.js';
import { getForum } from '../src/forums/index.js';
import { analyzeThreadsResponse, parseThreadsResponse, searchThreads } from '../src/services/perplexity.js';
import { createSearchLogService, toSearchRequestRow } from '../src/services/searchLog.js';

const reddit = getForum('reddit');
const hn = getForum('hackernews');
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pplx = loadConfig({ PERPLEXITY_API_KEY: 'k', PERPLEXITY_BASE_URL: 'https://pplx.test' });
const day = (s) => new Date(`${s}T00:00:00Z`);
const t = (over) => ({ title: 'T', url: '', intent: 'seeking', asks_for: 'a', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.5, ...over });
const completion = (threads, searchResults = []) => ({ model: 'sonar-pro', usage: { total_tokens: 42 }, search_results: searchResults, choices: [{ message: { content: JSON.stringify({ problem: 'I cannot find customers', threads }) } }] });

// ---------- drop reasons ----------

test('analyzeThreadsResponse gives a reason for every proposed thread it discards', () => {
  const data = completion([
    t({ url: 'https://www.reddit.com/r/a/comments/k1/keep/', relevance_score: 0.9 }),
    t({ url: 'https://www.reddit.com/r/a/comments/k2/keep2/', relevance_score: 0.8 }),
    t({ url: 'https://www.reddit.com/r/a/comments/k3/over/', relevance_score: 0.1 }),
    t({ url: 'https://www.reddit.com/r/a/comments/k1/keep', relevance_score: 0.9 }),
    t({ url: 'https://www.reddit.com/r/smallbusiness/', relevance_score: 1 }),
    t({ url: 'https://www.quora.com/Some-question', relevance_score: 1 }),
    t({ url: 'https://www.reddit.com/r/a/comments/k4/launch/', intent: 'offering', relevance_score: 1 }),
    t({ url: 'not a url' }),
    t({ url: 'ftp://reddit.com/r/a/comments/k5/x/' }),
  ]);
  const out = analyzeThreadsResponse(data, { forums: [reddit, hn], threads: 2 });
  assert.deepEqual(out.threads.map((x) => x.url), ['https://www.reddit.com/r/a/comments/k1/keep/', 'https://www.reddit.com/r/a/comments/k2/keep2/']);
  assert.equal(out.modelThreadCount, 9);
  assert.equal(out.usedFallback, false);
  assert.deepEqual(Object.fromEntries(out.dropped.map((d) => [d.url, d.reason])), {
    'https://www.reddit.com/r/a/comments/k1/keep': 'duplicate',
    'https://www.reddit.com/r/smallbusiness/': 'not_a_thread',
    'https://www.quora.com/Some-question': 'not_on_requested_forum',
    'https://www.reddit.com/r/a/comments/k4/launch/': 'offering',
    'not a url': 'invalid_url',
    'ftp://reddit.com/r/a/comments/k5/x/': 'invalid_url',
    'https://www.reddit.com/r/a/comments/k3/over/': 'over_limit',
  });
  assert.equal(out.threads.length + out.dropped.length, out.modelThreadCount, 'every proposed thread is accounted for');
  assert.deepEqual(parseThreadsResponse(data, { forums: [reddit, hn], threads: 2 }), out.threads, 'the old helper still returns just the kept threads');
});

test('an unusable model output is flagged as the fallback', () => {
  const data = { search_results: [{ title: 'x', url: 'https://www.reddit.com/r/a/comments/z1/x/' }], choices: [{ message: { content: 'prose, not JSON' } }] };
  const out = analyzeThreadsResponse(data, { forums: [reddit], threads: 5 });
  assert.deepEqual([out.usedFallback, out.modelThreadCount, out.threads.length], [true, 1, 1]);
});

// ---------- diagnostics from the search call ----------

test('searchThreads returns diagnostics: the exact prompt, settings, search result links, drops, and timing', async () => {
  let sent;
  const data = completion(
    [t({ url: 'https://www.reddit.com/r/a/comments/k1/x/', relevance_score: 0.9 }), t({ url: 'https://www.reddit.com/r/smallbusiness/' })],
    [{ url: 'https://www.reddit.com/r/a/comments/k1/x/' }, { url: 'https://www.reddit.com/r/smallbusiness/' }, { title: 'no url' }],
  );
  const out = await searchThreads({ productDescription: 'Finds leads', forums: [reddit], threads: 5, from: day('2026-09-01'), to: day('2026-09-02'), config: pplx, fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return jsonRes(data); } });
  const d = out.diagnostics;
  assert.equal(d.prompt, sent.messages[0].content, 'the logged prompt is exactly what was sent');
  assert.ok(!('messages' in d.settings) && !('response_format' in d.settings));
  assert.deepEqual(d.settings.search_domain_filter, ['reddit.com']);
  assert.equal(d.settings.search_after_date_filter, '09/01/2026');
  assert.equal(d.settings.model, 'sonar-pro');
  assert.deepEqual(d.searchResultUrls, ['https://www.reddit.com/r/a/comments/k1/x/', 'https://www.reddit.com/r/smallbusiness/']);
  assert.equal(d.rawResultCount, 3);
  assert.equal(d.modelThreadCount, 2);
  assert.deepEqual(d.dropped, [{ url: 'https://www.reddit.com/r/smallbusiness/', reason: 'not_a_thread' }]);
  assert.equal(d.problem, 'I cannot find customers');
  assert.deepEqual(d.usage, { total_tokens: 42 });
  assert.ok(Number.isInteger(d.durationMs) && d.durationMs >= 0);
  assert.equal(out.threads.length, 1);
});

test('a failed Perplexity call still carries the prompt and settings for the log', async () => {
  await assert.rejects(
    searchThreads({ productDescription: 'Finds leads', forums: [reddit], threads: 5, from: day('2026-09-01'), to: day('2026-09-02'), config: pplx, fetchImpl: async () => jsonRes({ error: 'bad' }, 400) }),
    (err) => err.status === 502 && /Finds leads/.test(err.diagnostics.prompt) && err.diagnostics.settings.model === 'sonar-pro' && Number.isInteger(err.diagnostics.durationMs),
  );
});

// ---------- row mapping and writing ----------

test('toSearchRequestRow maps an entry to the table columns and caps oversized fields', () => {
  const row = toSearchRequestRow({
    productId: 'p1', userId: 'u1', forums: ['reddit', 'x'], threadsRequested: 10, from: '2026-09-01', to: '2026-09-02', status: 'ok', returnedCount: 4,
    diagnostics: { prompt: 'x'.repeat(25000), settings: { model: 'sonar-pro' }, rawResultCount: 12, searchResultUrls: Array.from({ length: 250 }, (_, i) => `https://x.com/u/status/${i}`), modelThreadCount: 9, usedFallback: false, dropped: [{ url: 'u', reason: 'not_a_thread' }], problem: 'p', usage: { total_tokens: 1 }, durationMs: 1234.6 },
  });
  assert.deepEqual(
    [row.product_id, row.user_id, row.forums, row.threads_requested, row.date_from, row.date_to, row.status, row.returned_count, row.raw_result_count, row.model_thread_count, row.used_fallback, row.problem],
    ['p1', 'u1', ['reddit', 'x'], 10, '2026-09-01', '2026-09-02', 'ok', 4, 12, 9, false, 'p'],
  );
  assert.equal(row.prompt.length, 20000);
  assert.equal(row.search_result_urls.length, 200);
  assert.equal(row.duration_ms, 1235);
  assert.deepEqual([row.error, row.error_status], [null, null]);
  assert.deepEqual(row.dropped, [{ url: 'u', reason: 'not_a_thread' }]);
});

test('toSearchRequestRow for a failure without diagnostics leaves the result columns empty', () => {
  const row = toSearchRequestRow({ productId: 'p1', userId: 'u1', forums: ['reddit'], threadsRequested: 10, from: '2026-09-01', to: '2026-09-02', status: 'error', error: 'Perplexity request failed with HTTP 500', errorStatus: 502 });
  assert.deepEqual([row.status, row.error, row.error_status, row.prompt, row.returned_count, row.dropped, row.duration_ms], ['error', 'Perplexity request failed with HTTP 500', 502, null, null, null, null]);
});

test('record writes to search_requests as the caller and never throws', async () => {
  const calls = [];
  const errors = [];
  const logger = { error: (...a) => errors.push(a.join(' ')) };
  const entry = { productId: 'p', userId: 'u', forums: [], threadsRequested: 1, from: '2026-09-01', to: '2026-09-01', status: 'ok' };
  const ok = createSearchLogService({ insert: async (token, table, row) => { calls.push([token, table, row.status]); return row; } }, { logger });
  assert.equal(await ok.record('tok', entry), true);
  assert.deepEqual(calls, [['tok', 'search_requests', 'ok']]);
  const failing = createSearchLogService({ insert: async () => { throw new Error('db down'); } }, { logger });
  assert.equal(await failing.record('tok', entry), false);
  assert.match(errors.at(-1), /search log write failed: db down/);
});

// ---------- route ----------

const PID = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
const OTHER = 'b1e90fbd-9ddf-4c0e-a953-616a94d4891c';
const config = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon', PERPLEXITY_API_KEY: 'k' });
const fakeVerify = async (token) => { if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false }; throw new HttpError(401, 'Invalid token'); };
const fakeProducts = { get: async (tok, id) => { if (id !== PID) throw new HttpError(404, 'Not found'); return { id, name: 'P', description: 'Finds leads', website: null }; }, list: async () => [], create: async () => ({}), update: async () => ({}) };
const fakeResults = { save: async (tok, pid, threads) => threads.map((x, i) => ({ id: `r${i}`, link: x.url })), list: async () => ({ results: [], total: 0 }) };
let logs = [];
const fakeLog = { record: async (token, entry) => { logs.push({ token, entry }); return true; } };
let searchImpl;
const listen = async (app) => { const s = app.listen(0); await new Promise((r) => s.once('listening', r)); return s; };
let server;
let base;
before(async () => { server = await listen(createApp({ config, verify: fakeVerify, products: fakeProducts, results: fakeResults, search: (a) => searchImpl(a), searchLog: fakeLog })); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const post = (b, body) => fetch(`${b}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer good' }, body: JSON.stringify(body) });

test('a successful search writes one ok entry with the request, and diagnostics stay out of the response', async () => {
  logs = [];
  searchImpl = async () => ({ threads: [{ url: 'https://www.reddit.com/r/a/comments/k1/x/', title: 'T', relevanceScore: 0.9, source: 'reddit' }], meta: { model: 'fake' }, diagnostics: { prompt: 'PROMPT', dropped: [{ url: 'u', reason: 'not_a_thread' }] } });
  const res = await post(base, { productId: PID, forum: ['reddit', 'x'], threads: 7, from: '2026-09-01', to: '2026-09-03' });
  assert.equal(res.status, 200);
  assert.ok(!('diagnostics' in (await res.json())), 'the prompt and drops are not sent to the browser');
  assert.equal(logs.length, 1);
  const { token, entry } = logs[0];
  assert.equal(token, 'good', 'written with the caller token, so row-level security applies');
  const { diagnostics, ...rest } = entry;
  assert.deepEqual(rest, { productId: PID, userId: 'user-1', forums: ['reddit', 'x'], threadsRequested: 7, from: '2026-09-01', to: '2026-09-03', status: 'ok', returnedCount: 1 });
  assert.equal(diagnostics.prompt, 'PROMPT');
});

test('a failed search writes one error entry with its diagnostics and still returns the error', async () => {
  logs = [];
  searchImpl = async () => { const err = new PerplexityError('Perplexity request failed with HTTP 500', { status: 502 }); err.diagnostics = { prompt: 'PROMPT' }; throw err; };
  const res = await post(base, { productId: PID, forum: 'reddit' });
  assert.equal(res.status, 502);
  assert.equal(logs.length, 1);
  assert.deepEqual([logs[0].entry.status, logs[0].entry.error, logs[0].entry.errorStatus, logs[0].entry.diagnostics.prompt], ['error', 'Perplexity request failed with HTTP 500', 502, 'PROMPT']);
});

test('requests rejected before the search, such as an unknown product or bad input, are not logged', async () => {
  logs = [];
  assert.equal((await post(base, { productId: OTHER, forum: 'reddit' })).status, 404);
  assert.equal((await post(base, { productId: PID, forum: 'myspace' })).status, 400);
  assert.equal(logs.length, 0);
});

test('a log write failure does not affect the search response', async () => {
  const failingLog = createSearchLogService({ insert: async () => { throw new Error('db down'); } }, { logger: { error: () => {} } });
  const s = await listen(createApp({ config, verify: fakeVerify, products: fakeProducts, results: fakeResults, search: async () => ({ threads: [], meta: {}, diagnostics: {} }), searchLog: failingLog }));
  const res = await post(`http://127.0.0.1:${s.address().port}`, { productId: PID, forum: 'reddit' });
  assert.equal(res.status, 200);
  s.close();
});
