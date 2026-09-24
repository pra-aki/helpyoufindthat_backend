import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { parseResultsQuery } from '../src/validation.js';
import { createSupabaseRest } from '../src/services/supabaseRest.js';
import { createResultsService } from '../src/services/results.js';

// Searches are paid for from credits; these tests are about other things, so credits never run out.
const freeCredits = { spend: async () => ({ charged: true, balance: 100 }), refund: async () => 100, balance: async () => 100, history: async () => ({ transactions: [], total: 0 }) };

// ---------- validation ----------

test('parseResultsQuery defaults and coercion', () => {
  assert.deepEqual(parseResultsQuery({}), { limit: 50, offset: 0, source: undefined, minScore: undefined });
  assert.deepEqual(parseResultsQuery({ limit: '200', offset: '400', source: 'Hacker News', minScore: '0.5' }), { limit: 200, offset: 400, source: 'hackernews', minScore: 0.5 });
  assert.equal(parseResultsQuery({ limit: 1000 }).limit, 1000);
});

test('parseResultsQuery rejects out-of-range values', () => {
  const bad = (q, re) => assert.throws(() => parseResultsQuery(q), (e) => e.status === 400 && re.test(e.message));
  bad({ limit: 1001 }, /at most 1000/);
  bad({ limit: 0 }, /limit/);
  bad({ offset: -1 }, /offset/);
  bad({ source: 'myspace' }, /Unsupported source/);
  bad({ minScore: 1.5 }, /minScore/);
});

// ---------- PostgREST upsert + paging ----------

const cfg = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' }).supabase;
const jsonRes = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('upsert posts the batch with merge-duplicates on the conflict key', async () => {
  let captured;
  const db = createSupabaseRest(cfg, { fetchImpl: async (url, init) => { captured = { url: String(url), init }; return jsonRes([{ id: '1', link: 'a' }], 201); } });
  const rows = await db.upsert('tok', 'search_results', [{ link: 'a' }], { onConflict: 'product_id,link' });
  assert.deepEqual(rows, [{ id: '1', link: 'a' }]);
  assert.equal(captured.url, 'https://abc.supabase.co/rest/v1/search_results?on_conflict=product_id%2Clink');
  assert.equal(captured.init.headers.Prefer, 'resolution=merge-duplicates,return=representation');
  assert.equal(captured.init.headers.Accept, 'application/json');
});

test('selectPage asks for an exact count and reads the total from Content-Range', async () => {
  let captured;
  const db = createSupabaseRest(cfg, { fetchImpl: async (url, init) => { captured = { url: String(url), init }; return jsonRes([{ id: '1' }, { id: '2' }], 206, { 'content-range': '50-51/1234' }); } });
  const page = await db.selectPage('tok', 'search_results', { select: '*', limit: '2', offset: '50', source_site: undefined });
  assert.deepEqual(page, { rows: [{ id: '1' }, { id: '2' }], total: 1234 });
  assert.equal(captured.init.headers.Prefer, 'count=exact');
  assert.ok(!captured.url.includes('source_site'), 'undefined query values are omitted');
});

// ---------- results service ----------

const thread = (over = {}) => ({ title: 'T', url: 'https://www.reddit.com/r/a/comments/x1/t/', summary: 'S', whyRelevant: 'W', postedAt: '2026-09-01', relevanceScore: 0.87654, source: 'reddit', ...over });

test('save maps threads to rows, dedupes links within a batch, and returns stored rows in input order', async () => {
  let sent;
  const db = { select: async () => [], upsert: async (token, table, rows) => { sent = rows; return rows.slice().reverse().map((r, i) => ({ id: `id${i}`, ...r })); } };
  const svc = createResultsService(db);
  const when = new Date('2026-09-04T10:00:00Z');
  const stored = await svc.save('tok', 'prod-1', [thread(), thread({ url: 'https://news.ycombinator.com/item?id=1', source: 'hackernews', postedAt: 'unknown' }), thread()], { searchDate: when });
  assert.equal(sent.length, 2, 'duplicate link in the same batch is sent once');
  assert.deepEqual(sent[0], { product_id: 'prod-1', source_site: 'reddit', link: 'https://www.reddit.com/r/a/comments/x1/t/', title: 'T', summary: 'S', why_relevant: 'W', posted_at: '2026-09-01T00:00:00.000Z', relevance_score: 0.877, search_date: '2026-09-04T10:00:00.000Z' });
  assert.equal(sent[1].posted_at, null, 'unparseable dates become null');
  assert.deepEqual(stored.map((r) => [r.link, r.source, r.relevanceScore]), [['https://www.reddit.com/r/a/comments/x1/t/', 'reddit', 0.877], ['https://news.ycombinator.com/item?id=1', 'hackernews', 0.877]]);
  assert.deepEqual(stored.map((r) => r.isNew), [true, true], 'links the product did not have are new');
  assert.deepEqual(await svc.save('tok', 'prod-1', []), [], 'nothing to save makes no request');
});

test('save marks a link already stored under the product as not new, asking for it by quoted link', async () => {
  let q;
  const db = {
    select: async (token, table, query) => { q = query; return [{ link: 'https://www.reddit.com/r/a/comments/x1/t/' }]; },
    upsert: async (token, table, rows) => rows.map((r, i) => ({ id: `id${i}`, ...r })),
  };
  const svc = createResultsService(db);
  const stored = await svc.save('tok', 'prod-1', [thread(), thread({ url: 'https://news.ycombinator.com/item?id=1,2', source: 'hackernews' })]);
  assert.deepEqual(stored.map((r) => r.isNew), [false, true]);
  assert.equal(q.product_id, 'eq.prod-1');
  assert.equal(q.link, 'in.("https://www.reddit.com/r/a/comments/x1/t/","https://news.ycombinator.com/item?id=1,2")', 'links are quoted, so a comma in one does not split the list');
});

test('setResponded patches the row under its product, and reports a missing lead as null', async () => {
  const calls = [];
  const db = { update: async (token, table, query, patch) => { calls.push([query, patch]); return query.id === 'eq.r1' ? { id: 'r1', product_id: 'prod-1', link: 'l', responded_at: patch.responded_at } : (() => { throw new HttpError(404, 'Not found'); })(); } };
  const svc = createResultsService(db);
  const at = new Date('2026-09-19T10:00:00Z');

  const marked = await svc.setResponded('tok', 'prod-1', 'r1', true, { at });
  assert.equal(marked.respondedAt, '2026-09-19T10:00:00.000Z');
  assert.deepEqual(calls[0], [{ id: 'eq.r1', product_id: 'eq.prod-1' }, { responded_at: '2026-09-19T10:00:00.000Z' }], 'the product scopes the update');

  assert.equal((await svc.setResponded('tok', 'prod-1', 'r1', false, { at })).respondedAt, null);
  assert.equal(calls[1][1].responded_at, null, 'unmarking clears the column');
  assert.equal(await svc.setResponded('tok', 'prod-1', 'gone', true), null, 'no such lead under this product');
});

test('list builds the PostgREST query with ordering, paging, and optional filters', async () => {
  let q;
  const db = { selectPage: async (token, table, query) => { q = query; return { rows: [{ id: '1', product_id: 'p', source_site: 'x', link: 'l', relevance_score: '0.500', search_date: 's', created_at: 'c' }], total: 7 }; } };
  const svc = createResultsService(db);
  const out = await svc.list('tok', 'p', { limit: 10, offset: 20, source: 'x', minScore: 0.5 });
  assert.equal(q.product_id, 'eq.p');
  assert.equal(q.order, 'search_date.desc,relevance_score.desc.nullslast,created_at.desc');
  assert.deepEqual([q.limit, q.offset, q.source_site, q.relevance_score], ['10', '20', 'eq.x', 'gte.0.5']);
  assert.equal(out.total, 7);
  assert.equal(out.results[0].relevanceScore, 0.5, 'numeric comes back as a number');
  assert.equal(out.results[0].source, 'x');
});

// ---------- HTTP ----------

const config = loadConfig({ PERPLEXITY_MIN_INTERVAL_MS: '0', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon', PERPLEXITY_API_KEY: 'k' });
const fakeVerify = async (token) => { if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false }; throw new HttpError(401, 'Invalid token'); };
const PID = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
const OTHER = 'b1e90fbd-9ddf-4c0e-a953-616a94d4891c';
const fakeProducts = { get: async (token, id) => { if (id !== PID) throw new HttpError(404, 'Not found'); return { id, name: 'P', description: 'stored description', website: 'https://p.example/' }; }, list: async () => [], create: async () => ({}) };
let searchCalls = 0;
const fakeSearch = async () => { searchCalls++; return { threads: [thread(), thread({ url: 'https://news.ycombinator.com/item?id=1', source: 'hackernews' })], meta: { model: 'fake' } }; };
const saved = [];
const fakeResults = {
  save: async (token, productId, threads, { searchDate }) => { const rows = threads.map((t, i) => ({ id: `r${i}`, productId, link: t.url, searchDate: searchDate.toISOString() })); saved.push(...rows); return rows; },
  list: async (token, productId, page) => ({ results: saved.slice(page.offset, page.offset + page.limit), total: saved.length }),
};
let server; let base;
before(async () => { server = createApp({ credits: freeCredits, searchLog: { record: async () => true },  config, verify: fakeVerify, search: fakeSearch, products: fakeProducts, results: fakeResults }).listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const auth = { authorization: 'Bearer good' };
const post = (body) => fetch(`${base}/api/threads`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) });

test('search without productId is rejected', async () => {
  const res = await post({ forum: 'reddit' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /productId/);
  assert.equal(saved.length, 0);
});

test('search with productId uses the stored description, stores the threads, and returns their ids', async () => {
  const res = await post({ forum: 'reddit', productId: PID });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.saved && { productId: body.saved.productId, count: body.saved.count }, { productId: PID, count: 2 });
  assert.ok(body.saved.searchDate);
  assert.deepEqual(body.threads.map((t) => t.id), ['r0', 'r1']);
  assert.equal(body.query.productDescription, 'stored description');
  assert.equal(saved.length, 2);
});

test('search with an unknown productId is a 404 before Perplexity is called', async () => {
  const before = searchCalls;
  const res = await post({ forum: 'reddit', productId: OTHER });
  assert.equal(res.status, 404);
  assert.equal(searchCalls, before);
  assert.equal((await post({ forum: 'reddit', productId: 'nope' })).status, 400);
});

test('GET /api/products/:id/results pages stored results and 404s for foreign products', async () => {
  const res = await fetch(`${base}/api/products/${PID}/results?limit=1&offset=1`, { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.productId, body.count, body.total, body.limit, body.offset], [PID, 1, 2, 1, 1]);
  assert.equal(body.results[0].id, 'r1');
  assert.equal((await fetch(`${base}/api/products/${OTHER}/results`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/products/${PID}/results?limit=5000`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${base}/api/products/${PID}/results`)).status, 401);
});
