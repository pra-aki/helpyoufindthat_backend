import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { parseLeadUpdate } from '../src/validation.js';
import { createResultsService } from '../src/services/results.js';

// ---------- validation ----------

test('parseLeadUpdate takes responded, a rating, or both', () => {
  assert.deepEqual(parseLeadUpdate({ responded: true }), { responded: true });
  assert.deepEqual(parseLeadUpdate({ useful: true }), { useful: true });
  assert.deepEqual(parseLeadUpdate({ useful: false, note: '  Wrong industry ' }), { useful: false, note: 'Wrong industry' });
  assert.deepEqual(parseLeadUpdate({ useful: false, details: 'via the details spelling' }), { useful: false, note: 'via the details spelling' });
  assert.deepEqual(parseLeadUpdate({ useful: false, note: '' }), { useful: false }, 'an empty note is no note, which saves as none');
  assert.deepEqual(parseLeadUpdate({ useful: null }), { useful: null }, 'null clears the rating');
  assert.deepEqual(parseLeadUpdate({ responded: true, useful: true }), { responded: true, useful: true });
  const bad = (body, re) => assert.throws(() => parseLeadUpdate(body), (e) => e.status === 400 && re.test(e.message), `expected ${re} for ${JSON.stringify(body)}`);
  bad({}, /"responded", "useful", or both/);
  bad({ useful: 'yes' }, /true, false, or null/);
  bad({ useful: 1 }, /true, false, or null/);
  bad({ note: 'no rating' }, /goes with a rating/);
  bad({ useful: null, note: 'clearing with a note' }, /goes with a rating/);
  bad({ useful: true, note: 'x'.repeat(2001) }, /at most 2000/);
  bad({ useful: true, note: 7 }, /must be a string/);
  bad(null, /JSON object/);
});

// ---------- storage ----------

test('setFeedback rates under the product as the user, and a new rating replaces the old note', async () => {
  const calls = [];
  const db = { update: async (token, table, query, patch) => { calls.push([token, table, query, patch]); if (query.id === 'eq.gone') throw new HttpError(404, 'Not found'); return { id: 'r1', product_id: 'p1', link: 'https://x', search_date: 's', created_at: 'c', ...patch }; } };
  const svc = createResultsService(db);
  const at = new Date('2026-10-19T12:00:00Z');
  const rated = await svc.setFeedback('tok', 'p1', 'r1', { useful: false, note: 'Wrong industry' }, { at });
  assert.deepEqual(calls[0], ['tok', 'search_results', { id: 'eq.r1', product_id: 'eq.p1' }, { useful: false, feedback_note: 'Wrong industry', rated_at: '2026-10-19T12:00:00.000Z' }]);
  assert.deepEqual([rated.useful, rated.feedbackNote, rated.ratedAt], [false, 'Wrong industry', '2026-10-19T12:00:00.000Z']);

  await svc.setFeedback('tok', 'p1', 'r1', { useful: true }, { at });
  assert.deepEqual(calls[1][3], { useful: true, feedback_note: null, rated_at: '2026-10-19T12:00:00.000Z' }, 'rating again without a note clears the old one');

  const cleared = await svc.setFeedback('tok', 'p1', 'r1', { useful: null });
  assert.deepEqual(calls[2][3], { useful: null, feedback_note: null, rated_at: null });
  assert.deepEqual([cleared.useful, cleared.feedbackNote, cleared.ratedAt], [null, null, null]);

  assert.equal(await svc.setFeedback('tok', 'p1', 'gone', { useful: true }), null, 'no such lead under this product');
});

test('a search that finds a rated lead again leaves its rating alone', async () => {
  const sent = [];
  const svc = createResultsService({ select: async () => [], upsert: async (token, table, rows) => { sent.push(rows); return rows.map((r, i) => ({ id: `r${i}`, ...r })); } }, { serviceToken: 'svc' });
  await svc.save('tok', 'p1', [{ url: 'https://www.reddit.com/r/a/comments/k1/x/', source: 'reddit', title: 'T', relevanceScore: 0.9 }]);
  for (const column of ['useful', 'feedback_note', 'rated_at']) {
    assert.ok(!(column in sent[0][0]), `${column} is not written by a search, so the upsert keeps it`);
  }
});

// ---------- the route ----------

const PID = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
const LEAD = 'c2e90fbd-9ddf-4c0e-a953-616a94d4891c';
const MISSING = 'd3e90fbd-9ddf-4c0e-a953-616a94d4891c';
const fakeVerify = async (token) => { if (token === 'good') return { id: 'user-1', email: 'u@e.com', role: 'authenticated', isAnonymous: false }; throw new HttpError(401, 'Invalid token'); };
const fakeProducts = { get: async (token, id) => { if (id !== PID) throw new HttpError(404, 'Not found'); return { id, name: 'P', description: 'd' }; } };
const calls = [];
const lead = (over) => ({ id: LEAD, productId: PID, respondedAt: null, useful: null, feedbackNote: null, ratedAt: null, ...over });
const fakeResults = {
  setResponded: async (token, productId, id, responded) => { calls.push(['responded', token, productId, id, responded]); return id === LEAD ? lead({ respondedAt: responded ? 't' : null }) : null; },
  setFeedback: async (token, productId, id, feedback) => { calls.push(['feedback', token, productId, id, feedback]); return id === LEAD ? lead({ useful: feedback.useful, feedbackNote: feedback.note ?? null, ratedAt: feedback.useful === null ? null : 't' }) : null; },
};
let server; let base;
before(async () => {
  server = createApp({ config: loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' }), verify: fakeVerify, products: fakeProducts, results: fakeResults }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const patch = (resultId, body, headers = { authorization: 'Bearer good', 'content-type': 'application/json' }) =>
  fetch(`${base}/api/products/${PID}/results/${resultId}`, { method: 'PATCH', headers, body: JSON.stringify(body) });

test('PATCH a lead with a rating saves it as the user and returns the rated lead', async () => {
  calls.length = 0;
  const res = await patch(LEAD, { useful: false, note: 'Selling, not buying' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { productId: PID, result: lead({ useful: false, feedbackNote: 'Selling, not buying', ratedAt: 't' }) });
  assert.deepEqual(calls, [['feedback', 'good', PID, LEAD, { useful: false, note: 'Selling, not buying' }]]);

  const cleared = await patch(LEAD, { useful: null });
  assert.equal((await cleared.json()).result.useful, null);
});

test('responded and a rating can change together, and marking responded alone still works as before', async () => {
  calls.length = 0;
  const both = await patch(LEAD, { responded: true, useful: true });
  assert.equal(both.status, 200);
  assert.deepEqual(calls.map((c) => c[0]), ['responded', 'feedback']);
  calls.length = 0;
  assert.equal((await patch(LEAD, { responded: false })).status, 200);
  assert.deepEqual(calls.map((c) => c[0]), ['responded'], 'no rating is touched');
});

test('a missing lead is 404, bad input 400, and no token 401, with nothing saved', async () => {
  calls.length = 0;
  assert.equal((await patch(MISSING, { useful: true })).status, 404);
  calls.length = 0;
  assert.equal((await patch(LEAD, { useful: 'yes' })).status, 400);
  assert.equal((await patch(LEAD, { note: 'no rating' })).status, 400);
  assert.equal((await patch(LEAD, { useful: true }, { 'content-type': 'application/json' })).status, 401);
  assert.equal(calls.length, 0);
});
