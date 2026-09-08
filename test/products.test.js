import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { parseProductRequest, parseUuid } from '../src/validation.js';
import { createSupabaseRest } from '../src/services/supabaseRest.js';
import { createProductsService } from '../src/services/products.js';

// ---------- validation ----------

test('parseProductRequest accepts camelCase and snake_case, normalises website', () => {
  const a = parseProductRequest({ name: ' Acme ', website: 'acme.com', description: 'Does things' });
  assert.deepEqual(a, { name: 'Acme', website: 'https://acme.com/', description: 'Does things', generalReply: undefined });
  const b = parseProductRequest({ productName: 'X', product_website: 'https://x.io/p?q=1', productDescription: 'd' });
  assert.equal(b.website, 'https://x.io/p?q=1');
  assert.equal(parseProductRequest({ name: 'X', description: 'd' }).website, null);
});

test('parseProductRequest rejects bad input with 400', () => {
  const bad = (body, re) => assert.throws(() => parseProductRequest(body), (e) => e.status === 400 && re.test(e.message));
  bad({ description: 'd' }, /name/);
  bad({ name: 'X' }, /description/);
  bad({ name: 'X', description: 'd', website: 'not a url' }, /website/);
  bad({ name: 'X', description: 'd', website: 42 }, /website/);
  bad({ name: 'x'.repeat(201), description: 'd' }, /at most 200/);
  bad(null, /JSON object/);
});

test('parseUuid', () => {
  assert.equal(parseUuid('A0E90FBD-9DDF-4C0E-A953-616A94D4891C'), 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c');
  assert.throws(() => parseUuid('123'), (e) => e.status === 400);
});

// ---------- PostgREST client ----------

const cfg = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon-key' }).supabase;
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('insert sends the user token, anon key, and asks for the row back', async () => {
  let captured;
  const db = createSupabaseRest(cfg, { fetchImpl: async (url, init) => { captured = { url: String(url), init }; return jsonRes({ id: '1', name: 'A' }, 201); } });
  const row = await db.insert('user-token', 'products', { name: 'A' });
  assert.equal(row.id, '1');
  assert.equal(captured.url, 'https://abc.supabase.co/rest/v1/products');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.apikey, 'anon-key');
  assert.equal(captured.init.headers.Authorization, 'Bearer user-token');
  assert.equal(captured.init.headers.Prefer, 'return=representation');
  assert.equal(captured.init.headers.Accept, 'application/vnd.pgrst.object+json');
  assert.deepEqual(JSON.parse(captured.init.body), { name: 'A' });
});

test('update sends a PATCH with the filter query and asks for the row back', async () => {
  let captured;
  const db = createSupabaseRest(cfg, { fetchImpl: async (url, init) => { captured = { url: String(url), init }; return jsonRes({ id: '1', name: 'B' }); } });
  const row = await db.update('user-token', 'products', { id: 'eq.1' }, { name: 'B' });
  assert.equal(row.name, 'B');
  assert.equal(captured.url, 'https://abc.supabase.co/rest/v1/products?id=eq.1');
  assert.equal(captured.init.method, 'PATCH');
  assert.equal(captured.init.headers.Prefer, 'return=representation');
  assert.deepEqual(JSON.parse(captured.init.body), { name: 'B' });
});

test('select builds query string; selectOne maps 406 to 404', async () => {
  let captured;
  const db = createSupabaseRest(cfg, { fetchImpl: async (url) => { captured = String(url); return jsonRes([]); } });
  await db.select('t', 'products', { select: '*', order: 'created_at.desc' });
  assert.equal(captured, 'https://abc.supabase.co/rest/v1/products?select=*&order=created_at.desc');

  const missing = createSupabaseRest(cfg, { fetchImpl: async () => jsonRes({ message: 'no rows' }, 406) });
  await assert.rejects(missing.selectOne('t', 'products', { id: 'eq.x' }), (e) => e.status === 404);
});

test('maps PostgREST errors: 401, 403 (RLS), 400, 5xx, network', async () => {
  const mk = (status, body = { message: 'm' }) => createSupabaseRest(cfg, { fetchImpl: async () => jsonRes(body, status) });
  await assert.rejects(mk(401).select('t', 'products', {}), (e) => e.status === 401);
  await assert.rejects(mk(403, { message: 'new row violates row-level security policy' }).insert('t', 'products', {}), (e) => e.status === 403);
  await assert.rejects(mk(400, { message: 'bad', code: '22P02' }).select('t', 'products', {}), (e) => e.status === 400 && e.details.code === '22P02');
  await assert.rejects(mk(500).select('t', 'products', {}), (e) => e.status === 502);
  const down = createSupabaseRest(cfg, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.select('t', 'products', {}), (e) => e.status === 502);
  const unconfigured = createSupabaseRest(loadConfig({}).supabase, { fetchImpl: async () => jsonRes([]) });
  await assert.rejects(unconfigured.select('t', 'products', {}), (e) => e.status === 500 && /SUPABASE/.test(e.message));
});

// ---------- products service ----------

test('products service maps rows to camelCase and stamps user_id on create', async () => {
  const calls = [];
  const fakeDb = {
    insert: async (token, table, row) => { calls.push(['insert', token, table, row]); return { id: 'p1', name: row.name, website: row.website, description: row.description, user_id: row.user_id, created_at: 'c', updated_at: 'u' }; },
    select: async () => [{ id: 'p1', name: 'A', website: null, description: 'd', user_id: 'u1', created_at: 'c', updated_at: 'u' }],
    selectOne: async (token, table, query) => { calls.push(['selectOne', query]); return { id: 'p1', name: 'A', website: null, description: 'd', user_id: 'u1', created_at: 'c', updated_at: 'u' }; },
    update: async (token, table, query, patch) => { calls.push(['update', token, table, query, patch]); return { id: 'p1', name: patch.name, website: patch.website, description: patch.description, user_id: 'u1', created_at: 'c', updated_at: 'u2' }; },
  };
  const svc = createProductsService(fakeDb);
  const created = await svc.create('tok', { id: 'u1' }, { name: 'A', website: null, description: 'd' });
  assert.deepEqual(created, { id: 'p1', name: 'A', website: null, description: 'd', generalReply: null, userId: 'u1', createdAt: 'c', updatedAt: 'u' });
  assert.deepEqual(calls[0], ['insert', 'tok', 'products', { name: 'A', website: null, description: 'd', user_id: 'u1' }]);
  assert.equal((await svc.list('tok')).length, 1);
  await svc.get('tok', 'p1');
  assert.deepEqual(calls[1], ['selectOne', { select: '*', id: 'eq.p1' }]);

  const updated = await svc.update('tok', 'p1', { name: 'B', website: null, description: 'd2' });
  assert.deepEqual(updated, { id: 'p1', name: 'B', website: null, description: 'd2', generalReply: null, userId: 'u1', createdAt: 'c', updatedAt: 'u2' });
  assert.deepEqual(calls[2], ['update', 'tok', 'products', { id: 'eq.p1' }, { name: 'B', website: null, description: 'd2' }]);
});

// ---------- HTTP routes ----------

const config = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' });
const fakeVerify = async (token) => {
  if (token === 'good') return { id: 'user-1', email: 'u@example.com', role: 'authenticated', isAnonymous: false };
  throw new HttpError(401, 'Invalid token');
};
const store = [];
const fakeProducts = {
  create: async (token, user, input) => { const p = { id: `p${store.length + 1}`, ...input, userId: user.id, createdAt: 'c', updatedAt: 'u' }; store.push(p); return p; },
  list: async () => [...store].reverse(),
  get: async (token, id) => { const p = store.find((x) => x.id === id); if (!p) throw new HttpError(404, 'Not found'); return p; },
  update: async (token, id, input) => { const p = store.find((x) => x.id === id); if (!p) throw new HttpError(404, 'Not found'); Object.assign(p, input); return p; },
};
let server; let base;
before(async () => {
  server = createApp({ config, verify: fakeVerify, products: fakeProducts }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const auth = { authorization: 'Bearer good' };
const json = { 'content-type': 'application/json' };

test('POST /api/products requires auth, validates, and returns 201 with the product', async () => {
  const noAuth = await fetch(`${base}/api/products`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'A', description: 'd' }) });
  assert.equal(noAuth.status, 401);
  const invalid = await fetch(`${base}/api/products`, { method: 'POST', headers: { ...json, ...auth }, body: JSON.stringify({ name: 'A' }) });
  assert.equal(invalid.status, 400);
  const ok = await fetch(`${base}/api/products`, { method: 'POST', headers: { ...json, ...auth }, body: JSON.stringify({ name: 'Acme', website: 'acme.com', description: 'Does things' }) });
  assert.equal(ok.status, 201);
  const { product } = await ok.json();
  assert.equal(product.name, 'Acme');
  assert.equal(product.website, 'https://acme.com/');
  assert.equal(product.userId, 'user-1');
});

test('GET /api/products lists and GET /api/products/:id fetches or 404s', async () => {
  const list = await (await fetch(`${base}/api/products`, { headers: auth })).json();
  assert.equal(list.products.length, 1);
  const one = await fetch(`${base}/api/products/${list.products[0].id === 'p1' ? 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c' : 'x'}`, { headers: auth });
  assert.equal(one.status, 404, 'unknown uuid is 404');
  const badId = await fetch(`${base}/api/products/not-a-uuid`, { headers: auth });
  assert.equal(badId.status, 400);
});

test('PATCH /api/products/:id updates in place, keeping the id, and 404s for unknown ids', async () => {
  // Own fake store with real UUIDs, since parseUuid rejects the "p1"-style
  // ids the shared fixture above uses.
  const id = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
  const productsWithUuid = {
    ...fakeProducts,
    get: async (token, pid) => { if (pid !== id) throw new HttpError(404, 'Not found'); return { id, name: 'Acme', website: null, description: 'Does things', userId: 'user-1' }; },
    update: async (token, pid, input) => ({ id: pid, ...input, userId: 'user-1' }),
  };
  const fresh = createApp({ config, verify: fakeVerify, products: productsWithUuid }).listen(0);
  await new Promise((r) => fresh.once('listening', r));
  const freshBase = `http://127.0.0.1:${fresh.address().port}`;

  const noAuth = await fetch(`${freshBase}/api/products/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'B', description: 'd2' }) });
  assert.equal(noAuth.status, 401);

  const invalid = await fetch(`${freshBase}/api/products/${id}`, { method: 'PATCH', headers: { ...json, ...auth }, body: JSON.stringify({ name: 'B' }) });
  assert.equal(invalid.status, 400);

  const ok = await fetch(`${freshBase}/api/products/${id}`, { method: 'PATCH', headers: { ...json, ...auth }, body: JSON.stringify({ name: 'Acme Renamed', website: 'acme.com', description: 'Updated description' }) });
  assert.equal(ok.status, 200);
  const { product } = await ok.json();
  assert.equal(product.id, id);
  assert.equal(product.name, 'Acme Renamed');
  assert.equal(product.description, 'Updated description');

  const unknown = await fetch(`${freshBase}/api/products/11111111-1111-1111-1111-111111111111`, { method: 'PATCH', headers: { ...json, ...auth }, body: JSON.stringify({ name: 'B', description: 'd' }) });
  assert.equal(unknown.status, 404);

  fresh.close();
});
