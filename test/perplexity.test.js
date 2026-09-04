import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { getForum } from '../src/forums/index.js';
import { searchThreads, parseThreadsResponse, formatPerplexityDate } from '../src/services/perplexity.js';

const config = loadConfig({ PERPLEXITY_API_KEY: 'test-key', PERPLEXITY_BASE_URL: 'https://pplx.test/' });
const reddit = getForum('reddit');

const completion = (threads, searchResults = []) => ({
  model: 'sonar-pro',
  usage: { total_tokens: 10 },
  search_results: searchResults,
  choices: [{ message: { content: JSON.stringify({ threads }) } }],
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('date helpers', () => {
  assert.equal(formatPerplexityDate(new Date('2026-09-02T00:00:00Z')), '09/02/2026');
});

test('sends the right request to Perplexity: auth header, domain filter, date window, no key in body', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return jsonResponse(completion([]));
  };
  const now = new Date('2026-09-02T12:00:00Z');
  await searchThreads({ productDescription: 'A tool that does X', forum: reddit, threads: 3, days: 7, config, fetchImpl, now });

  assert.equal(captured.url, 'https://pplx.test/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(captured.body.search_domain_filter, ['reddit.com']);
  assert.equal(captured.body.search_after_date_filter, '08/26/2026');
  assert.equal(captured.body.search_recency_filter, undefined, 'Perplexity rejects recency + date filters together');
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.match(captured.body.messages[1].content, /A tool that does X/);
  assert.match(captured.body.messages[1].content, /up to 3 public Reddit threads/);
  assert.ok(!captured.init.body.includes('test-key'), 'API key must not leak into the request body');
});

test('filters to forum domains and real thread URLs, dedupes, sorts by score, limits to x', () => {
  const data = completion(
    [
      { title: 'Weak', url: 'https://www.reddit.com/r/a/comments/aaa111/weak/', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.2 },
      { title: 'Strong', url: 'https://reddit.com/r/a/comments/bbb222/strong', summary: 's', why_relevant: 'w', posted_at: '2026-09-01', relevance_score: 0.9 },
      { title: 'Dup', url: 'https://reddit.com/r/a/comments/bbb222/strong/', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.9 },
      { title: 'Subreddit index', url: 'https://www.reddit.com/r/a/', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 1 },
      { title: 'Wrong site', url: 'https://news.ycombinator.com/item?id=1', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 1 },
      { title: 'Medium', url: 'https://www.reddit.com/r/a/comments/ccc333/medium/', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.5 },
      { title: 'Garbage', url: 'not a url', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 1 },
    ],
    [{ title: 'Weak (search)', url: 'https://www.reddit.com/r/a/comments/aaa111/weak/', date: '2026-08-31' }],
  );
  const out = parseThreadsResponse(data, { forum: reddit, threads: 2 });
  assert.deepEqual(out.map((t) => t.title), ['Strong', 'Medium']);
  assert.equal(out[0].source, 'reddit');
  assert.equal(out[0].postedAt, '2026-09-01');

  const all = parseThreadsResponse(data, { forum: reddit, threads: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[2].postedAt, '2026-08-31', 'date is backfilled from search_results');
});

test('falls back to search_results when the model content is not JSON', () => {
  const data = {
    search_results: [
      { title: 'From search', url: 'https://www.reddit.com/r/a/comments/ddd444/x/', date: '2026-09-01' },
      { title: 'Index page', url: 'https://www.reddit.com/r/a/' },
    ],
    choices: [{ message: { content: 'Sorry, here is some prose instead.' } }],
  };
  const out = parseThreadsResponse(data, { forum: reddit, threads: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'From search');
});

test('parses JSON wrapped in a code fence', () => {
  const data = {
    choices: [{ message: { content: '```json\n{"threads":[{"title":"T","url":"https://reddit.com/r/a/comments/eee555/t","summary":"","why_relevant":"","posted_at":"","relevance_score":0.7}]}\n```' } }],
  };
  assert.equal(parseThreadsResponse(data, { forum: reddit, threads: 5 }).length, 1);
});

test('maps upstream failures to HTTP errors', async () => {
  const base = { productDescription: 'd', forum: reddit, threads: 1, days: 1, config };
  await assert.rejects(
    searchThreads({ ...base, fetchImpl: async () => jsonResponse({ error: 'nope' }, 401) }),
    (err) => err.status === 502 && /HTTP 401/.test(err.message),
  );
  await assert.rejects(
    searchThreads({ ...base, fetchImpl: async () => jsonResponse({}, 429) }),
    (err) => err.status === 429,
  );
  await assert.rejects(
    searchThreads({ ...base, fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } }),
    (err) => err.status === 504,
  );
  await assert.rejects(
    searchThreads({ ...base, config: loadConfig({}) }),
    (err) => err.status === 500 && /PERPLEXITY_API_KEY/.test(err.message),
  );
});
