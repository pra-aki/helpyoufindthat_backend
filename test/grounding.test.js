import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { getForum } from '../src/forums/index.js';
import { analyzeThreadsResponse, canonicalKey, searchThreads } from '../src/services/perplexity.js';
import { toSearchRequestRow } from '../src/services/searchLog.js';

const reddit = getForum('reddit');
const hn = getForum('hackernews');
const x = getForum('x');
const quora = getForum('quora');
const facebook = getForum('facebook-groups');
const config = loadConfig({ PERPLEXITY_MIN_INTERVAL_MS: '0', PERPLEXITY_API_KEY: 'k', PERPLEXITY_BASE_URL: 'https://pplx.test' });
const day = (s) => new Date(`${s}T00:00:00Z`);
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const thread = (url, score = 0.5, over = {}) => ({ title: url, url, intent: 'seeking', asks_for: 'a', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: score, ...over });
const reply = ({ threads = [], sources = [], citations = [], usage = { total_tokens: 10 }, problem = 'p' } = {}) => ({
  model: 'sonar-pro', usage, citations, search_results: sources.map((url) => ({ url })), choices: [{ message: { content: JSON.stringify({ problem, threads }) } }],
});
const base = { productDescription: 'Finds leads', threads: 3, from: day('2026-09-01'), to: day('2026-09-02'), config };
const domainOf = (init) => JSON.parse(init.body).search_domain_filter[0];

// ---------- link matching ----------

test('canonicalKey matches the same post written different ways, and keeps different posts apart', () => {
  const k = (u) => canonicalKey(new URL(u));
  assert.equal(k('https://x.com/someone/status/1234567890'), k('https://twitter.com/i/status/1234567890?s=20&t=abc'));
  assert.equal(k('https://www.reddit.com/r/smallbusiness/comments/1abc2de/need_a_crm/'), k('https://old.reddit.com/r/SmallBusiness/comments/1abc2de/'));
  assert.equal(k('https://news.ycombinator.com/item?id=41234567'), 'hn:41234567');
  assert.equal(k('https://www.quora.com/Is-there-a-tool?utm_source=x'), k('https://quora.com/Is-there-a-tool/'));
  assert.notEqual(k('https://www.quora.com/Question-A'), k('https://www.quora.com/Question-B'));
  assert.notEqual(k('https://x.com/a/status/1'), k('https://x.com/a/status/2'));
});

// ---------- grounding ----------

test('a thread whose link Perplexity never returned is dropped as not_in_sources, and the list is not padded', () => {
  const data = reply({
    threads: [thread('https://www.reddit.com/r/a/comments/real1/x/', 0.9), thread('https://www.reddit.com/r/a/comments/fake9/invented/', 0.95), thread('https://x.com/user/status/111', 0.8)],
    sources: ['https://www.reddit.com/r/a/comments/real1/x/'],
    citations: ['https://x.com/i/status/111'],
  });
  const out = analyzeThreadsResponse(data, { forums: [reddit, x], threads: 10 });
  assert.deepEqual(out.threads.map((t) => t.url), ['https://www.reddit.com/r/a/comments/real1/x/', 'https://x.com/user/status/111'], 'a citation counts as a source, matched by post');
  assert.deepEqual(out.dropped, [{ url: 'https://www.reddit.com/r/a/comments/fake9/invented/', reason: 'not_in_sources' }]);
});

test('fabricated Facebook and Quora threads like the ones seen in production are rejected', () => {
  const data = reply({
    threads: [
      thread('https://www.facebook.com/groups/moviebuffs/posts/any-apps-to-log-all-my-watched-movies', 0.75),
      thread('https://www.quora.com/Is-there-an-app-that-recommends-movies-based-on-what-I-liked', 0.9),
    ],
    sources: ['https://www.facebook.com/somepage/'],
  });
  const out = analyzeThreadsResponse(data, { forums: [quora, facebook], threads: 10 });
  assert.equal(out.threads.length, 0);
  assert.deepEqual(out.dropped.map((d) => d.reason), ['not_in_sources', 'not_in_sources']);
});

// ---------- one call per forum ----------

test('searchThreads starts one call per forum at the same time, each searching only that forum', async () => {
  const bodies = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const byDomain = {
    'reddit.com': reply({ threads: [thread('https://www.reddit.com/r/a/comments/r1/x/', 0.4)], sources: ['https://www.reddit.com/r/a/comments/r1/x/'] }),
    'news.ycombinator.com': reply({ threads: [thread('https://news.ycombinator.com/item?id=900001', 0.6)], sources: ['https://news.ycombinator.com/item?id=900001'] }),
    'x.com': reply({ threads: [thread('https://x.com/u/status/700001', 0.9)], sources: ['https://x.com/u/status/700001'] }),
  };
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    await gate;
    return jsonRes(byDomain[domainOf(init)]);
  };
  const pending = searchThreads({ ...base, forums: [reddit, hn, x], fetchImpl });
  await new Promise((r) => setImmediate(r));
  assert.equal(bodies.length, 3, 'all three calls started before any finished');
  release();
  const { threads, meta, diagnostics } = await pending;

  assert.deepEqual(bodies.map((b) => b.search_domain_filter), [['reddit.com'], ['news.ycombinator.com'], ['x.com', 'twitter.com']]);
  for (const [b, name] of [[bodies[0], 'Reddit'], [bodies[1], 'Hacker News'], [bodies[2], 'X \\(Twitter\\)']]) {
    assert.match(b.messages[0].content, new RegExp(`^Search for 3 threads or discussions in user forums on ${name} posted between`));
    assert.ok(!/across all sites/.test(b.messages[0].content), 'each call names a single forum');
  }
  assert.deepEqual(threads.map((t) => [t.source, t.relevanceScore]), [['x', 0.9], ['hackernews', 0.6], ['reddit', 0.4]], 'merged across forums by score');
  assert.deepEqual(meta.searchedForums, ['reddit', 'hackernews', 'x']);
  assert.deepEqual(meta.failedForums, []);
  assert.deepEqual(meta.usage, { total_tokens: 30 }, 'usage is summed across calls');
  assert.equal(diagnostics.calls.length, 3);
  assert.match(diagnostics.prompt, /^=== reddit ===\nSearch for 3 threads/);
  assert.deepEqual(diagnostics.settings.search_domain_filter_by_forum, { reddit: ['reddit.com'], hackernews: ['news.ycombinator.com'], x: ['x.com', 'twitter.com'] });
});

test('the best threads win across forums, and the rest are logged as over_limit with their forum', async () => {
  const byDomain = {
    'reddit.com': reply({ threads: [0.35, 0.3, 0.25].map((s, i) => thread(`https://www.reddit.com/r/a/comments/w${i}/x/`, s)), sources: [0, 1, 2].map((i) => `https://www.reddit.com/r/a/comments/w${i}/x/`) }),
    'x.com': reply({ threads: [0.9, 0.8].map((s, i) => thread(`https://x.com/u/status/80000${i}`, s)), sources: [0, 1].map((i) => `https://x.com/u/status/80000${i}`) }),
  };
  const { threads, diagnostics } = await searchThreads({ ...base, forums: [reddit, x], fetchImpl: async (u, init) => jsonRes(byDomain[domainOf(init)]) });
  assert.deepEqual(threads.map((t) => [t.source, t.relevanceScore]), [['x', 0.9], ['x', 0.8], ['reddit', 0.35]]);
  assert.deepEqual(diagnostics.dropped.filter((d) => d.reason === 'over_limit').map((d) => d.forum), ['reddit', 'reddit']);
});

test('if one forum call fails, the others still return and the failure is reported', async () => {
  const fetchImpl = async (u, init) =>
    domainOf(init) === 'x.com'
      ? jsonRes({ error: 'rate limited' }, 429)
      : jsonRes(reply({ threads: [thread('https://www.reddit.com/r/a/comments/ok1/x/', 0.7)], sources: ['https://www.reddit.com/r/a/comments/ok1/x/'] }));
  const { threads, meta, diagnostics } = await searchThreads({ ...base, forums: [reddit, x], fetchImpl });
  assert.deepEqual(threads.map((t) => t.source), ['reddit']);
  assert.deepEqual(meta.failedForums, [{ forum: 'x', error: 'Perplexity request failed with HTTP 429', status: 429 }]);
  assert.deepEqual(diagnostics.calls.map((c) => [c.forum, c.ok]), [['reddit', true], ['x', false]]);
});

test('if every forum call fails, the first error is thrown with diagnostics for the log', async () => {
  await assert.rejects(
    searchThreads({ ...base, forums: [reddit, x], fetchImpl: async () => jsonRes({}, 500) }),
    (err) => err.status === 502 && err.diagnostics.calls.length === 2 && err.diagnostics.calls.every((c) => !c.ok) && /^=== reddit ===/.test(err.diagnostics.prompt),
  );
});

// ---------- log row ----------

test('the log row carries citation links and the per-forum call breakdown', () => {
  const row = toSearchRequestRow({
    productId: 'p', userId: 'u', forums: ['reddit', 'x'], threadsRequested: 3, from: '2026-09-01', to: '2026-09-02', status: 'ok', returnedCount: 3,
    diagnostics: { citationUrls: ['https://x.com/i/status/1'], calls: [{ forum: 'reddit', ok: true }, { forum: 'x', ok: false, error: 'e', status: 429 }] },
  });
  assert.deepEqual(row.citation_urls, ['https://x.com/i/status/1']);
  assert.deepEqual(row.calls, [{ forum: 'reddit', ok: true }, { forum: 'x', ok: false, error: 'e', status: 429 }]);
});
