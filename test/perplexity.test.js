import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { getForum } from '../src/forums/index.js';
import { searchThreads, parseThreadsResponse, formatPerplexityDate, buildUserPrompt } from '../src/services/perplexity.js';

const config = loadConfig({ PERPLEXITY_API_KEY: 'test-key', PERPLEXITY_BASE_URL: 'https://pplx.test/' });
const reddit = getForum('reddit');
const hn = getForum('hackernews');
const x = getForum('x');

// By default every proposed thread was cited by Perplexity, so tests of other rules are unaffected by the
// grounding check; test/grounding.test.js covers threads that were not.
const completion = (threads, searchResults = [], citations = threads.map((t) => t.url)) => ({
  model: 'sonar-pro',
  usage: { total_tokens: 10 },
  citations,
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
  const from = new Date('2026-08-26T00:00:00Z');
  const to = new Date('2026-09-02T00:00:00Z');
  await searchThreads({ productDescription: 'A tool that does X', forums: [reddit], threads: 3, from, to, config, fetchImpl });

  assert.equal(captured.url, 'https://pplx.test/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(captured.body.search_domain_filter, ['reddit.com']);
  assert.equal(captured.body.search_after_date_filter, '08/26/2026');
  assert.equal(captured.body.search_before_date_filter, '09/03/2026', 'day after "to", since the before filter is exclusive');
  assert.equal(captured.body.search_recency_filter, undefined, 'Perplexity rejects recency + date filters together');
  assert.match(captured.body.messages[0].content, /posted between 2026-08-26 and 2026-09-02 \(inclusive\)/);
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.match(captured.body.messages[0].content, /A tool that does X/);
  assert.match(captured.body.messages[0].content, /^Search for 3 threads or discussions in user forums on Reddit posted between/);
  assert.equal(captured.body.messages.length, 1, 'search sends a single user message');
  assert.equal(captured.body.messages[0].role, 'user');
  assert.match(captured.body.messages[0].content, /never invent, guess, or alter a URL/);
  assert.ok(!captured.body.messages[0].content.includes('empty list'), 'no empty-list instruction');
  assert.match(captured.body.messages[0].content, /where users are looking for a solution: a recommendation, a tool, a service, an alternative, or advice, for a problem that can be solved by our product:/);
  assert.match(captured.body.messages[0].content, /Never include posts that offer rather than ask:\n- product launches/);
  assert.deepEqual(captured.body.response_format.json_schema.schema.required, ['problem', 'threads']);
  assert.deepEqual(captured.body.response_format.json_schema.schema.properties.threads.items.properties.intent.enum, ['seeking', 'offering', 'discussion']);
  assert.deepEqual(captured.body.web_search_options, { search_context_size: 'medium' });
  assert.ok(!captured.init.body.includes('test-key'), 'API key must not leak into the request body');
});

test('a multi-forum search sends one call per forum and tags each thread with its source', async () => {
  const bodies = [];
  const byDomain = {
    'reddit.com': completion([
      { title: 'Reddit', url: 'https://www.reddit.com/r/a/comments/abc123/t/', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.9 },
      { title: 'Quora (not requested)', url: 'https://www.quora.com/Some-question', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 1 },
    ]),
    'news.ycombinator.com': completion([{ title: 'HN', url: 'https://news.ycombinator.com/item?id=41', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.7 }]),
    'x.com': completion([{ title: 'X', url: 'https://x.com/u/status/123', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.8 }]),
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return jsonResponse(byDomain[body.search_domain_filter[0]]);
  };
  const day = new Date('2026-09-04T00:00:00Z');
  const { threads, meta } = await searchThreads({ productDescription: 'd', forums: [reddit, hn, x], threads: 10, from: day, to: day, config, fetchImpl });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map((b) => b.search_domain_filter), [['reddit.com'], ['news.ycombinator.com'], ['x.com', 'twitter.com']]);
  assert.match(bodies[0].messages[0].content, /in user forums on Reddit posted between/);
  assert.ok(bodies.every((b) => !b.messages[0].content.includes('What counts as a thread')), 'no per-site thread hints');
  assert.deepEqual(threads.map((t) => [t.title, t.source]), [['Reddit', 'reddit'], ['X', 'x'], ['HN', 'hackernews']]);
  assert.deepEqual(meta.searchedForums, ['reddit', 'hackernews', 'x']);
  assert.deepEqual([meta.from, meta.to], ['2026-09-04', '2026-09-04']);
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
  const out = parseThreadsResponse(data, { forums: [reddit], threads: 2 });
  assert.deepEqual(out.map((t) => t.title), ['Strong', 'Medium']);
  assert.equal(out[0].source, 'reddit');
  assert.equal(out[0].postedAt, '2026-09-01');

  const all = parseThreadsResponse(data, { forums: [reddit], threads: 10 });
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
  const out = parseThreadsResponse(data, { forums: [reddit], threads: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'From search');
});

test('parses JSON wrapped in a code fence', () => {
  const data = {
    citations: ['https://reddit.com/r/a/comments/eee555/t'],
    choices: [{ message: { content: '```json\n{"threads":[{"title":"T","url":"https://reddit.com/r/a/comments/eee555/t","summary":"","why_relevant":"","posted_at":"","relevance_score":0.7}]}\n```' } }],
  };
  assert.equal(parseThreadsResponse(data, { forums: [reddit], threads: 5 }).length, 1);
});

test('maps upstream failures to HTTP errors', async () => {
  const base = { productDescription: 'd', forums: [reddit], threads: 1, from: new Date('2026-09-03T00:00:00Z'), to: new Date('2026-09-04T00:00:00Z'), config };
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

test('only threads the model labels as offering are dropped; discussion threads are kept to fill the count', () => {
  const data = completion([
    { title: 'Launch', url: 'https://www.reddit.com/r/a/comments/aaa111/launch/', intent: 'offering', asks_for: '', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.95 },
    { title: 'Need help', url: 'https://www.reddit.com/r/a/comments/bbb222/need/', intent: 'seeking', asks_for: 'a CRM that nags me to follow up', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.8 },
    { title: 'Debate', url: 'https://www.reddit.com/r/a/comments/ccc333/debate/', intent: 'discussion', asks_for: '', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.7 },
    { title: 'Legacy shape', url: 'https://www.reddit.com/r/a/comments/ddd444/old/', summary: 's', why_relevant: 'w', posted_at: '', relevance_score: 0.6 },
  ]);
  const out = parseThreadsResponse(data, { forums: [reddit], threads: 10 });
  assert.deepEqual(out.map((t) => t.title), ['Need help', 'Debate', 'Legacy shape'], 'offering is dropped; discussion and a missing intent are kept, sorted by score');
  assert.equal(out[0].asksFor, 'a CRM that nags me to follow up');
  assert.equal(out[1].asksFor, null);
});

test('the problem statement is surfaced in meta', async () => {
  const body = { model: 'sonar-pro', search_results: [], choices: [{ message: { content: JSON.stringify({ problem: 'I keep forgetting to follow up with leads', threads: [] }) } }] };
  const { meta } = await searchThreads({ productDescription: 'd', forums: [reddit], threads: 5, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z'), config, fetchImpl: async () => jsonResponse(body) });
  assert.equal(meta.problem, 'I keep forgetting to follow up with leads');
});

test('prompt opens with the search request, then the product, with no problem-statement step or per-site hints', () => {
  const p = buildUserPrompt({ productDescription: 'An app that reminds owners to follow up with leads', forums: [reddit], threads: 5, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') });
  assert.match(p, /^Search for 5 threads or discussions in user forums on Reddit posted between 2026-09-01 and 2026-09-02 \(inclusive\)/);
  assert.match(p, /our product:\n\n"""\nAn app that reminds owners to follow up with leads\n"""/);
  for (const gone of ['We sell this product', 'state the problem', 'HAVE that problem', 'Search the way those people write', 'What counts as a thread', 'A thread is a Reddit post', 'empty list']) {
    assert.ok(!p.includes(gone), `prompt should not contain "${gone}"`);
  }
  assert.match(p, /A partial fit still counts/);
});

test('the prompt asks for the full count and fills it with low-scored weaker matches instead of returning fewer', () => {
  const p = buildUserPrompt({ productDescription: 'X', forums: [reddit], threads: 7, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') });
  assert.ok(!/up to 7/.test(p), 'no "up to" wording');
  assert.match(p, /Return 7 threads\. If fewer than 7 strongly match, fill the rest with the closest weaker matches/);
  assert.match(p, /give those a relevance score of 0\.3 or lower/);
  assert.match(p, /Do not return fewer than 7 while real threads remain in your search results/);

  const neverInclude = p.slice(p.indexOf('Never include posts that offer rather than ask:'), p.indexOf('Posts like these are "offering"'));
  assert.match(neverInclude, /product launches/);
  assert.ok(!/general discussion/.test(neverInclude), 'general discussion is no longer excluded');
  assert.match(p, /leave them out at any score/);
});

test('the score description names the low band as the fill', async () => {
  let body;
  await searchThreads({ productDescription: 'X', forums: [reddit], threads: 5, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z'), config, fetchImpl: async (u, init) => { body = JSON.parse(init.body); return jsonResponse(completion([])); } });
  assert.match(body.response_format.json_schema.schema.properties.threads.items.properties.relevance_score.description, /0\.3 or lower = general discussion of the topic or a loose fit, included to fill the requested count/);
});
