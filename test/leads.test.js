import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { parseUuidList, parseWebsite } from '../src/validation.js';
import { createSupabaseRest } from '../src/services/supabaseRest.js';
import { createResultsService } from '../src/services/results.js';
import { describeWebsite } from '../src/services/perplexity.js';

const A = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
const B = 'b1e90fbd-9ddf-4c0e-a953-616a94d4891c';
const C = 'c2e90fbd-9ddf-4c0e-a953-616a94d4891c';
const PID = 'd3e90fbd-9ddf-4c0e-a953-616a94d4891c';

// ---------- validation ----------

test('parseUuidList accepts arrays, comma strings, and single ids; dedupes and caps', () => {
  assert.deepEqual(parseUuidList([A, B, A.toUpperCase()]), [A, B]);
  assert.deepEqual(parseUuidList(`${A}, ${B}`), [A, B]);
  assert.deepEqual(parseUuidList(A), [A]);
  const bad = (input, re, opts) => assert.throws(() => parseUuidList(input, opts), (e) => e.status === 400 && re.test(e.message));
  bad([], /at least one/);
  bad(undefined, /at least one/);
  bad([A, 'nope'], /must be a UUID/);
  bad([A, B, C], /at most 2/, { max: 2 });
});

test('parseWebsite normalises and rejects junk', () => {
  assert.equal(parseWebsite('acme.com'), 'https://acme.com/');
  assert.equal(parseWebsite(' http://acme.com/pricing '), 'http://acme.com/pricing');
  for (const v of ['', 'not a url', 'localhost', 'ftp://acme.com', 42]) {
    assert.throws(() => parseWebsite(v), (e) => e.status === 400, `rejects ${JSON.stringify(v)}`);
  }
});

// ---------- REST delete + results.remove ----------

const cfg = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' }).supabase;
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('remove issues a scoped DELETE and returns the deleted ids', async () => {
  let captured;
  const db = createSupabaseRest(cfg, { fetchImpl: async (url, init) => { captured = { url: String(url), init }; return jsonRes([{ id: A }, { id: B }]); } });
  const svc = createResultsService(db);
  const deleted = await svc.remove('tok', PID, [A, B, C]);
  assert.deepEqual(deleted, [A, B]);
  assert.equal(captured.init.method, 'DELETE');
  assert.equal(captured.init.headers.Prefer, 'return=representation');
  const u = new URL(captured.url);
  assert.equal(u.pathname, '/rest/v1/search_results');
  assert.equal(u.searchParams.get('product_id'), `eq.${PID}`);
  assert.equal(u.searchParams.get('id'), `in.(${A},${B},${C})`);
  assert.deepEqual(await svc.remove('tok', PID, []), [], 'empty list makes no request');
});

// ---------- describeWebsite ----------

const pplx = loadConfig({ PERPLEXITY_API_KEY: 'k', PERPLEXITY_BASE_URL: 'https://pplx.test' });

test('describeWebsite asks Perplexity to read the site, scoped to its domain, and returns a trimmed result', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = JSON.parse(init.body);
    return jsonRes({ model: 'sonar-pro', usage: { total_tokens: 1 }, search_results: [{ url: 'https://www.acme.com/' }, { url: 'https://www.acme.com/pricing' }], choices: [{ message: { content: JSON.stringify({ name: ' Acme ', description: 'Acme reminds landscapers to call leads back. It is for small crews. They lose quotes because nobody follows up.', problem: 'I keep forgetting to follow up with quotes', audience: 'small landscaping businesses', confidence: 0.8 }) } }] });
  };
  const out = await describeWebsite({ website: 'https://www.acme.com/', config: pplx, fetchImpl });
  assert.deepEqual(captured.search_domain_filter, ['acme.com']);
  assert.match(captured.messages[1].content, /Read the product website at https:\/\/www\.acme\.com\//);
  assert.match(captured.messages[1].content, /the problem it solves for them/);
  assert.equal(captured.response_format.type, 'json_schema');
  assert.equal(out.name, 'Acme');
  assert.match(out.description, /^Acme reminds/);
  assert.equal(out.problem, 'I keep forgetting to follow up with quotes');
  assert.equal(out.confidence, 0.8);
  assert.deepEqual(out.meta.sources, ['https://www.acme.com/', 'https://www.acme.com/pricing']);
});

test('describeWebsite fails with 502 when the model returns no description', async () => {
  const fetchImpl = async () => jsonRes({ choices: [{ message: { content: 'nope' } }] });
  await assert.rejects(describeWebsite({ website: 'https://acme.com/', config: pplx, fetchImpl }), (e) => e.status === 502);
});

// ---------- HTTP ----------

const config = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon', PERPLEXITY_API_KEY: 'k' });
const fakeVerify = async (token) => { if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false }; throw new HttpError(401, 'Invalid token'); };
const fakeProducts = { get: async (token, id) => { if (id !== PID) throw new HttpError(404, 'Not found'); return { id, name: 'P', description: 'd' }; }, list: async () => [], create: async () => ({}) };
let store = [A, B, C];
const fakeResults = { remove: async (token, productId, ids) => { const hit = ids.filter((x) => store.includes(x)); store = store.filter((x) => !hit.includes(x)); return hit; }, save: async () => [], list: async () => ({ results: [], total: 0 }) };
let describeCalls = [];
const fakeDescribe = async ({ website }) => { describeCalls.push(website); return { website, name: 'N', description: 'D', problem: 'P', audience: 'A', confidence: 1, meta: {} }; };
let server; let base;
before(async () => { server = createApp({ config, verify: fakeVerify, products: fakeProducts, results: fakeResults, describe: fakeDescribe }).listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const auth = { authorization: 'Bearer good' };
const json = { 'content-type': 'application/json' };

test('DELETE one lead: 200 with the id, 404 when it is not there, 401 without auth', async () => {
  const ok = await fetch(`${base}/api/products/${PID}/results/${A}`, { method: 'DELETE', headers: auth });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { productId: PID, deleted: 1, ids: [A] });
  assert.equal((await fetch(`${base}/api/products/${PID}/results/${A}`, { method: 'DELETE', headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/products/${PID}/results/${B}`, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(`${base}/api/products/${B}/results/${B}`, { method: 'DELETE', headers: auth })).status, 404, 'foreign product');
});

test('DELETE several leads via JSON body or query string, reporting which were not found', async () => {
  const res = await fetch(`${base}/api/products/${PID}/results`, { method: 'DELETE', headers: { ...auth, ...json }, body: JSON.stringify({ ids: [B, A] }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { productId: PID, deleted: 1, ids: [B], notFound: [A] });
  const viaQuery = await fetch(`${base}/api/products/${PID}/results?ids=${C}`, { method: 'DELETE', headers: auth });
  assert.deepEqual(await viaQuery.json(), { productId: PID, deleted: 1, ids: [C], notFound: [] });
  const empty = await fetch(`${base}/api/products/${PID}/results`, { method: 'DELETE', headers: { ...auth, ...json }, body: JSON.stringify({ ids: [] }) });
  assert.equal(empty.status, 400);
});

test('POST /api/products/describe validates the website and returns the generated description', async () => {
  const ok = await fetch(`${base}/api/products/describe`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ website: 'acme.com' }) });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.description, 'D');
  assert.deepEqual(describeCalls, ['https://acme.com/'], 'website is normalised before the call');
  assert.equal((await fetch(`${base}/api/products/describe`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({}) })).status, 400);
  assert.equal((await fetch(`${base}/api/products/describe`, { method: 'POST', headers: json, body: JSON.stringify({ website: 'acme.com' }) })).status, 401);
});

test('CORS preflight allows DELETE', async () => {
  const pre = await fetch(`${base}/api/products/${PID}/results`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'DELETE' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /DELETE/);
});
