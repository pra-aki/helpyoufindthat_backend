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

const unreachable = async () => { throw Object.assign(new Error('the domain does not resolve'), { code: 'ENOTFOUND' }); };
const describeReply = (over = {}) => jsonRes({ model: 'sonar-pro', usage: { total_tokens: 1 }, search_results: [{ url: 'https://www.acme.com/' }], choices: [{ message: { content: JSON.stringify({ name: ' Acme ', description: 'Acme reminds landscapers to call leads back.', problem: 'I keep forgetting to follow up', audience: 'small crews', confidence: 0.9, ...over }) } }] });

test('describeWebsite reads the page itself and gives its content to the model', async () => {
  let captured;
  const page = async (url) => ({ url, status: 200, html: '<title>Acme</title><body><h1>Call every lead back</h1><p>Acme reminds landscapers to call leads back before they go cold, from your phone, with no setup.</p></body>' });
  const out = await describeWebsite({ website: 'https://www.acme.com/', config: pplx, fetchPageImpl: page, fetchImpl: async (u, init) => { captured = JSON.parse(init.body); return describeReply(); } });
  const prompt = captured.messages[1].content;
  assert.match(prompt, /using the content read from the page below/);
  assert.match(prompt, /Title: Acme/);
  assert.match(prompt, /Headings: Call every lead back/);
  assert.match(prompt, /Page text: .*reminds landscapers/);
  assert.deepEqual(captured.search_domain_filter, ['acme.com']);
  assert.equal(out.source, 'page');
  assert.deepEqual(out.warnings, []);
  assert.equal(out.name, 'Acme');
  assert.equal(out.confidence, 0.9);
  assert.equal(out.meta.page.clientRendered, false);
});

test('describeWebsite on a client-rendered, noindexed page uses the metadata, caps confidence, and says why', async () => {
  let captured;
  const spa = async (url) => ({ url, status: 200, html: '<head><title>Lead Portal</title><meta name="description" content="Finds people asking for what you sell."><meta name="robots" content="noindex"><script src="/a.js"></script></head><body><div id="root"></div></body>' });
  const out = await describeWebsite({ website: 'https://portal.example/', config: pplx, fetchPageImpl: spa, fetchImpl: async (u, init) => { captured = JSON.parse(init.body); return describeReply({ confidence: 0.95 }); } });
  assert.match(captured.messages[1].content, /Only the page title and meta description were available/);
  assert.match(captured.messages[1].content, /Meta description: Finds people asking for what you sell\./);
  assert.ok(!/Page text:/.test(captured.messages[1].content));
  assert.equal(out.source, 'page');
  assert.equal(out.confidence, 0.5, 'a description built from metadata alone cannot claim high confidence');
  assert.ok(out.warnings.some((w) => /builds its content in the browser/.test(w)));
  assert.ok(out.warnings.some((w) => /noindex/.test(w)));
});

test('describeWebsite falls back to search when the page cannot be read, and tells the model not to guess', async () => {
  let captured;
  const out = await describeWebsite({ website: 'https://www.acme.com/', config: pplx, fetchPageImpl: unreachable, fetchImpl: async (u, init) => { captured = JSON.parse(init.body); return describeReply({ confidence: 0 }); } });
  assert.match(captured.messages[1].content, /Find and read the product website at https:\/\/www\.acme\.com\//);
  assert.match(captured.messages[1].content, /Do not guess what the product does from its name or domain/);
  assert.equal(out.source, 'search');
  assert.ok(out.warnings.some((w) => /could not be read directly \(the domain does not resolve\)/.test(w)));
});

test('describeWebsite rejects internal addresses with a 400 instead of spending a Perplexity call', async () => {
  let called = false;
  const refused = async () => { throw Object.assign(new Error('that address is not a public website'), { code: 'EBLOCKEDADDRESS' }); };
  await assert.rejects(
    describeWebsite({ website: 'http://127.0.0.1/', config: pplx, fetchPageImpl: refused, fetchImpl: async () => { called = true; return describeReply(); } }),
    (e) => e.status === 400 && /not a public website/.test(e.message),
  );
  assert.equal(called, false);
});

test('describeWebsite fails with 502 when the model returns no description', async () => {
  const fetchImpl = async () => jsonRes({ choices: [{ message: { content: 'nope' } }] });
  await assert.rejects(describeWebsite({ website: 'https://acme.com/', config: pplx, fetchPageImpl: unreachable, fetchImpl }), (e) => e.status === 502);
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
