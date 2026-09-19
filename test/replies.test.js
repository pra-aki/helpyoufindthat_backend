import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { parseProductRequest } from '../src/validation.js';
import { createProductsService } from '../src/services/products.js';
import { createResultsService } from '../src/services/results.js';
import { composeGeneralReply, parseThreadsResponse, buildUserPrompt, searchThreads } from '../src/services/perplexity.js';
import { getForum } from '../src/forums/index.js';

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pplx = loadConfig({ PERPLEXITY_MIN_INTERVAL_MS: '0', PERPLEXITY_API_KEY: 'k', PERPLEXITY_BASE_URL: 'https://pplx.test' });
const reddit = getForum('reddit');

// ---------- search no longer drafts replies ----------

test('the search prompt asks for threads only, with no reply-writing instructions', () => {
  const p = buildUserPrompt({ productDescription: 'X', forums: [reddit, getForum('hackernews')], threads: 5, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') });
  for (const gone of ['SECOND TASK', 'suggested_reply', 'bare link', 'How people write', 'Match the length and register', '40 to 80 words']) {
    assert.ok(!p.includes(gone), `prompt should not contain "${gone}"`);
  }
  assert.match(p, /A partial fit still counts/);
  assert.match(p, /never invent, guess, or alter a URL\.\n\nReturn JSON matching the schema\.$/);
});

test('the search schema has no suggested_reply and parsed threads carry none', async () => {
  let body;
  await searchThreads({ productDescription: 'X', forums: [reddit], threads: 5, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z'), config: pplx, fetchImpl: async (u, init) => { body = JSON.parse(init.body); return jsonRes({ choices: [{ message: { content: JSON.stringify({ problem: 'p', threads: [] }) } }] }); } });
  const item = body.response_format.json_schema.schema.properties.threads.items;
  assert.ok(!('suggested_reply' in item.properties));
  assert.ok(!item.required.includes('suggested_reply'));
  assert.equal(body.messages.length, 1, 'search sends a single user message');
  assert.ok(!body.messages[0].content.includes('draft a reply'), 'no reply rules anywhere in the request');

  const out = parseThreadsResponse({ citations: ['https://www.reddit.com/r/a/comments/a1/x/'], choices: [{ message: { content: JSON.stringify({ problem: 'p', threads: [{ title: 'A', url: 'https://www.reddit.com/r/a/comments/a1/x/', intent: 'seeking', asks_for: 'a tool', summary: 's', why_relevant: 'w', suggested_reply: 'stray draft', posted_at: '', relevance_score: 0.9 }] }) } }] }, { forums: [reddit], threads: 5 });
  assert.equal(out.length, 1);
  assert.ok(!('suggestedReply' in out[0]), 'a stray draft from the model is ignored');
});

test('results are stored and returned without a reply', async () => {
  let sent;
  const db = { select: async () => [], upsert: async (t, table, rows) => { sent = rows; return rows.map((r, i) => ({ id: `r${i}`, suggested_reply: 'old draft still in the column', ...r })); } };
  const svc = createResultsService(db);
  const stored = await svc.save('t', 'p1', [{ url: 'https://www.reddit.com/r/a/comments/x/y/', source: 'reddit', title: 'T', summary: 's', whyRelevant: 'w', postedAt: null, relevanceScore: 0.5 }]);
  assert.ok(!('suggested_reply' in sent[0]), 'the column is not written');
  assert.ok(!('suggestedReply' in stored[0]), 'an old draft left in the column is not returned');
});

// ---------- general reply composer ----------

test('composeGeneralReply sends the product, scopes search to its site, and trims the result', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = JSON.parse(init.body);
    return jsonRes({ model: 'sonar-pro', usage: { total_tokens: 5 }, choices: [{ message: { content: JSON.stringify({ reply: '  I lost quotes this way for years. I build FollowUp, which nudges you until you call a lead back.  ', notes: 'Name the tool they mentioned.' }) } }] });
  };
  const out = await composeGeneralReply({ product: { name: 'FollowUp', website: 'https://www.followup.app/', description: 'Reminds owners to follow up' }, config: pplx, fetchImpl });
  assert.deepEqual(captured.search_domain_filter, ['followup.app']);
  assert.match(captured.messages[1].content, /Product name: FollowUp/);
  assert.match(captured.messages[1].content, /Reminds owners to follow up/);
  assert.match(captured.messages[1].content, /the way you would type on a forum/);
  assert.match(captured.messages[1].content, /Never write "Great question"/);
  assert.match(captured.messages[1].content, /Point them at it with the bare link, once: https:\/\/www\.followup\.app\//);
  assert.match(captured.messages[1].content, /Do not claim to have had the problem yourself/);
  assert.equal(captured.temperature, 0.7, 'writing needs more room than extraction');
  assert.equal(out.reply, 'I lost quotes this way for years. I build FollowUp, which nudges you until you call a lead back.');
  assert.equal(out.notes, 'Name the tool they mentioned.');
});

test('composeGeneralReply omits the domain filter when there is no website, and 502s on an unusable reply', async () => {
  let captured;
  await composeGeneralReply({ product: { name: 'N', website: null, description: 'd' }, config: pplx, fetchImpl: async (u, init) => { captured = JSON.parse(init.body); return jsonRes({ choices: [{ message: { content: JSON.stringify({ reply: 'r', notes: '' }) } }] }); } });
  assert.equal(captured.search_domain_filter, undefined);
  await assert.rejects(
    composeGeneralReply({ product: { name: 'N', description: 'd' }, config: pplx, fetchImpl: async () => jsonRes({ choices: [{ message: { content: JSON.stringify({ reply: '   ' }) } }] }) }),
    (e) => e.status === 502,
  );
});

// ---------- storage ----------

test('products service exposes generalReply and only writes it when supplied', async () => {
  const calls = [];
  const db = { insert: async (t, table, row) => { calls.push(row); return { id: 'p1', ...row }; }, update: async (t, table, q, patch) => { calls.push(patch); return { id: 'p1', ...patch }; }, select: async () => [], selectOne: async () => ({ id: 'p1', general_reply: 'stored' }) };
  const svc = createProductsService(db);
  assert.equal((await svc.get('t', 'p1')).generalReply, 'stored');
  await svc.create('t', { id: 'u1' }, { name: 'N', website: null, description: 'd', generalReply: undefined });
  assert.ok(!('general_reply' in calls[0]), 'create without a reply omits the column');
  await svc.update('t', 'p1', { name: 'N', website: null, description: 'd2', generalReply: undefined });
  assert.ok(!('general_reply' in calls[1]), 'editing a product does not wipe the composed reply');
  await svc.update('t', 'p1', { name: 'N', website: null, description: 'd2', generalReply: 'mine' });
  assert.equal(calls[2].general_reply, 'mine');
  await svc.setGeneralReply('t', 'p1', 'composed');
  assert.deepEqual(calls[3], { general_reply: 'composed' });
});

test('parseProductRequest accepts an optional generalReply', () => {
  assert.equal(parseProductRequest({ name: 'N', description: 'd' }).generalReply, undefined);
  assert.equal(parseProductRequest({ name: 'N', description: 'd', generalReply: '  hi  ' }).generalReply, 'hi');
  assert.equal(parseProductRequest({ name: 'N', description: 'd', general_reply: '' }).generalReply, null);
  assert.throws(() => parseProductRequest({ name: 'N', description: 'd', generalReply: 42 }), (e) => e.status === 400);
  assert.throws(() => parseProductRequest({ name: 'N', description: 'd', generalReply: 'x'.repeat(4001) }), (e) => e.status === 400);
});

// ---------- HTTP ----------

const PID = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
const OTHER = 'b1e90fbd-9ddf-4c0e-a953-616a94d4891c';
const config = loadConfig({ PERPLEXITY_MIN_INTERVAL_MS: '0', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon', PERPLEXITY_API_KEY: 'k' });
const fakeVerify = async (token) => { if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false }; throw new HttpError(401, 'Invalid token'); };
let storedReply = null;
const fakeProducts = {
  get: async (t, id) => { if (id !== PID) throw new HttpError(404, 'Not found'); return { id, name: 'P', description: 'd', website: null, generalReply: storedReply }; },
  setGeneralReply: async (t, id, reply) => { storedReply = reply; return { id, name: 'P', description: 'd', generalReply: reply }; },
  list: async () => [], create: async () => ({}), update: async () => ({}),
};
const fakeCompose = async ({ product }) => ({ reply: `reply for ${product.name}`, notes: 'edit me', meta: { model: 'fake' } });
let server; let base;
before(async () => { server = createApp({ config, verify: fakeVerify, products: fakeProducts, results: { list: async () => ({ results: [], total: 0 }) }, compose: fakeCompose }).listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());
const auth = { authorization: 'Bearer good' };

test('POST /api/products/:id/reply composes and stores the general reply', async () => {
  const res = await fetch(`${base}/api/products/${PID}/reply`, { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.product.generalReply, 'reply for P');
  assert.equal(body.notes, 'edit me');
  assert.equal(storedReply, 'reply for P');
  assert.equal((await fetch(`${base}/api/products/${OTHER}/reply`, { method: 'POST', headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/api/products/${PID}/reply`, { method: 'POST' })).status, 401);
});

test('no forum voice tells the model to claim its own experience', () => {
  for (const f of [reddit, getForum('hackernews'), getForum('x'), getForum('quora'), getForum('linkedin-groups'), getForum('facebook-groups')]) {
    assert.ok(!/your own (experience|work)|we had this exact/i.test(f.voice), `${f.id} voice invites invented experience`);
  }
});

test('composeGeneralReply with no website tells the model not to invent a link', async () => {
  let captured;
  await composeGeneralReply({ product: { name: 'N', website: null, description: 'd' }, config: pplx, fetchImpl: async (u, init) => { captured = JSON.parse(init.body); return jsonRes({ choices: [{ message: { content: JSON.stringify({ reply: 'r', notes: 'n' }) } }] }); } });
  assert.match(captured.messages[1].content, /no link to give, so do not invent one/);
});

