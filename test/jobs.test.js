import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpError } from '../src/errors.js';
import { parseJobRequest, parseJobsQuery, parseEmail } from '../src/validation.js';
import { createJobsService } from '../src/services/jobs.js';
import { createSupabaseRest } from '../src/services/supabaseRest.js';
import { createMailer } from '../src/services/mailer.js';
import { createJobRunner, nextRunAtHour, msUntilHour, searchWindow } from '../src/jobs/runner.js';
import { leadsEmail } from '../src/jobs/email.js';

const config = loadConfig({
  PERPLEXITY_MIN_INTERVAL_MS: '0', PERPLEXITY_API_KEY: 'k', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service', RESEND_API_KEY: 'resend', EMAIL_FROM: 'Leads <leads@example.com>', SEARCH_JOBS_MAX_ACTIVE_PER_USER: '2',
});
const now = new Date('2026-09-17T10:00:00.000Z');
const PID = 'a0e90fbd-9ddf-4c0e-a953-616a94d4891c';
const OTHER = 'b1e90fbd-9ddf-4c0e-a953-616a94d4891c';
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------- validation ----------

test('parseJobRequest: defaults, spellings, and the date window', () => {
  const a = parseJobRequest({ forum: 'reddit', endDate: '2026-10-01' }, config, { now });
  assert.deepEqual([a.forums.map((f) => f.id), a.threads, a.minScore, a.startDate.toISOString(), a.endDate.toISOString(), a.email], [['reddit'], 10, 0.8, '2026-09-17T00:00:00.000Z', '2026-10-01T00:00:00.000Z', undefined]);
  const b = parseJobRequest({ forums: ['Reddit', 'hackernews'], until: '2026-09-17', maxThreads: '5', min_score: '0.9', email: ' me@example.com ' }, config, { now });
  assert.deepEqual([b.forums.map((f) => f.id), b.threads, b.minScore, b.email], [['reddit', 'hackernews'], 5, 0.9, 'me@example.com']);
  assert.equal(parseJobRequest({ forum: 'all', to: '2026-12-18' }, config, { now }).forums.length, 6, '92 days out is allowed');
});

test('parseJobRequest rejects bad input with 400', () => {
  const bad = (body, re) => assert.throws(() => parseJobRequest(body, config, { now }), (e) => e.status === 400 && re.test(e.message), `expected ${re} for ${JSON.stringify(body)}`);
  bad({ endDate: '2026-10-01' }, /forum/);
  bad({ forum: 'reddit' }, /endDate/);
  bad({ forum: 'reddit', endDate: 'soon' }, /endDate/);
  bad({ forum: 'reddit', endDate: '2026-09-16' }, /past/);
  bad({ forum: 'reddit', endDate: '2026-12-19' }, /at most 92 days/);
  bad({ forum: 'reddit', endDate: '2026-10-01', minScore: 1.5 }, /minScore/);
  bad({ forum: 'reddit', endDate: '2026-10-01', threads: 51 }, /threads/);
  bad({ forum: 'reddit', endDate: '2026-10-01', email: 'nope' }, /email/);
  bad(null, /JSON object/);
});

test('parseEmail and parseJobsQuery', () => {
  assert.equal(parseEmail('A@b.co'), 'A@b.co');
  assert.throws(() => parseEmail('a@b'), (e) => e.status === 400);
  assert.deepEqual(parseJobsQuery({ productId: PID.toUpperCase(), status: 'Active' }), { productId: PID, status: 'active' });
  assert.deepEqual(parseJobsQuery({}), { productId: undefined, status: undefined });
  assert.throws(() => parseJobsQuery({ status: 'paused' }), (e) => e.status === 400);
});

// ---------- jobs service ----------

const jobRow = (over = {}) => ({
  id: 'j1', product_id: PID, user_id: 'u1', email: 'u@example.com', forums: ['reddit'], threads: 10, min_score: '0.800', start_date: '2026-09-17', end_date: '2026-09-20',
  status: 'active', next_run_at: '2026-09-17T10:00:00+00:00', last_run_at: null, last_date_to: null, last_status: null, last_error: null, run_count: 0, created_at: 'c', updated_at: 'u', ...over,
});

test('jobs service: create stamps the user and forum ids; claim is a compare-and-set on next_run_at', async () => {
  const calls = [];
  const db = {
    insert: async (token, table, row) => { calls.push(['insert', token, table, row]); return jobRow({ next_run_at: row.next_run_at }); },
    update: async (token, table, query, patch) => { calls.push(['update', token, table, query, patch]); if (query.next_run_at === 'eq.stale') throw new HttpError(404, 'Not found'); return jobRow(patch); },
    select: async (token, table, query) => { calls.push(['select', token, table, query]); return [jobRow()]; },
    selectPage: async () => ({ rows: [], total: 3 }),
    selectOne: async () => jobRow(),
  };
  const svc = createJobsService(db);
  const created = await svc.create('tok', { id: 'u1' }, { productId: PID, email: 'u@example.com', forums: [{ id: 'reddit' }], threads: 10, minScore: 0.8, startDate: '2026-09-17', endDate: '2026-09-20', nextRunAt: now });
  assert.deepEqual(calls[0], ['insert', 'tok', 'search_jobs', { product_id: PID, user_id: 'u1', email: 'u@example.com', forums: ['reddit'], threads: 10, min_score: 0.8, start_date: '2026-09-17', end_date: '2026-09-20', status: 'active', next_run_at: '2026-09-17T10:00:00.000Z' }]);
  assert.deepEqual([created.minScore, created.status, created.runCount, created.lastRunAt], [0.8, 'active', 0, null], 'rows come back in camelCase with numeric score');
  assert.equal(await svc.countActive('tok'), 3);

  const due = await svc.due('service', { now, limit: 5 });
  assert.deepEqual(calls.at(-1), ['select', 'service', 'search_jobs', { select: '*', status: 'eq.active', next_run_at: 'lte.2026-09-17T10:00:00.000Z', order: 'next_run_at.asc', limit: '5' }]);
  const claimed = await svc.claim('service', due[0], { nextRunAt: new Date('2026-09-18T10:00:00Z'), lastRunAt: now });
  assert.deepEqual(calls.at(-1), ['update', 'service', 'search_jobs', { id: 'eq.j1', status: 'eq.active', next_run_at: 'eq.2026-09-17T10:00:00+00:00' }, { next_run_at: '2026-09-18T10:00:00.000Z', last_run_at: '2026-09-17T10:00:00.000Z' }]);
  assert.equal(claimed.nextRunAt, '2026-09-18T10:00:00.000Z');
  assert.equal(await svc.claim('service', { ...due[0], nextRunAt: 'stale' }, { nextRunAt: now, lastRunAt: now }), null, 'a job someone else moved is not claimed');

  const cancelled = await svc.cancel('tok', 'j1', { serviceToken: 'service', userId: 'u1' });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(calls.at(-1), ['update', 'service', 'search_jobs', { id: 'eq.j1', user_id: 'eq.u1' }, { status: 'cancelled' }], 'users cannot write jobs, so the backend writes with the service key, still filtered on the owner');
});

test('jobs service: cancelling a finished job leaves it alone', async () => {
  let updated = false;
  const svc = createJobsService({ selectOne: async () => jobRow({ status: 'completed' }), update: async () => { updated = true; } });
  assert.equal((await svc.cancel('tok', 'j1', { serviceToken: 'service', userId: 'u1' })).status, 'completed');
  assert.equal(updated, false);
});

// ---------- mailer ----------

test('mailer posts to Resend with the key, and reports failures as 502', async () => {
  let captured;
  const mailer = createMailer(config.email, { fetchImpl: async (url, init) => { captured = { url: String(url), init }; return jsonRes({ id: 'msg1' }); } });
  assert.equal(mailer.configured, true);
  assert.deepEqual(await mailer.send({ to: 'u@example.com', subject: 'S', text: 'T', html: '<p>T</p>' }), { id: 'msg1' });
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.init.headers.Authorization, 'Bearer resend');
  assert.deepEqual(JSON.parse(captured.init.body), { from: 'Leads <leads@example.com>', to: ['u@example.com'], subject: 'S', text: 'T', html: '<p>T</p>' });

  const rejected = createMailer(config.email, { fetchImpl: async () => jsonRes({ message: 'invalid from' }, 422) });
  await assert.rejects(rejected.send({ to: 'u@example.com', subject: 'S', text: 'T' }), (e) => e.status === 502 && e.details.reason === 'invalid from');
  const unconfigured = createMailer(loadConfig({}).email);
  assert.equal(unconfigured.configured, false);
  await assert.rejects(unconfigured.send({ to: 'x', subject: 's', text: 't' }), (e) => e.status === 500);
});

test('leadsEmail lists each lead and escapes HTML', () => {
  const job = { minScore: 0.8, endDate: '2026-09-20' };
  const leads = [{ title: 'Need a <CRM>', url: 'https://www.reddit.com/r/a/comments/k1/x/', source: 'reddit', relevanceScore: 0.92, asksFor: 'a reminder tool', summary: 'Keeps forgetting', postedAt: '2026-09-16' }];
  const { subject, text, html } = leadsEmail({ product: { name: 'FollowUp' }, job, leads, from: new Date('2026-09-16T00:00:00Z'), to: new Date('2026-09-17T00:00:00Z') });
  assert.equal(subject, '1 new lead for FollowUp');
  assert.match(text, /Need a <CRM>\n {2}https:\/\/www\.reddit\.com\/r\/a\/comments\/k1\/x\/\n {2}reddit · relevance 92% · posted 2026-09-16\n {2}Asks for: a reminder tool/);
  assert.match(text, /2026-09-16 to 2026-09-17/);
  assert.match(html, /Need a &lt;CRM&gt;/);
  assert.doesNotMatch(html, /<CRM>/);
});

// ---------- runner ----------

test('nextRunAtHour books the next daily slot, today if it is still ahead', () => {
  assert.equal(nextRunAtHour(3, new Date('2026-09-17T10:00:00Z')).toISOString(), '2026-09-18T03:00:00.000Z', 'past today\'s slot, so tomorrow');
  assert.equal(nextRunAtHour(3, new Date('2026-09-17T01:00:00Z')).toISOString(), '2026-09-17T03:00:00.000Z', 'slot still ahead today');
  assert.equal(nextRunAtHour(3, new Date('2026-09-17T03:00:00Z')).toISOString(), '2026-09-18T03:00:00.000Z', 'exactly on the slot books the next one');
  assert.equal(nextRunAtHour(0, new Date('2026-09-17T10:00:00Z')).toISOString(), '2026-09-18T00:00:00.000Z', 'midnight is a valid hour');
  assert.equal(msUntilHour(3, new Date('2026-09-17T02:00:00Z')), 60 * 60 * 1000);
});

test('searchWindow covers the trailing week, or further back to the last successful run after a long gap', () => {
  const day = (d) => d.toISOString().slice(0, 10);
  const w = (lastDateTo) => { const r = searchWindow({ lastDateTo }, { now, maxDays: 92, lookbackDays: 7 }); return [day(r.from), day(r.to)]; };
  assert.deepEqual(w(null), ['2026-09-10', '2026-09-17'], 'a first run looks back a week, past the index lag');
  assert.deepEqual(w('2026-09-16'), ['2026-09-10', '2026-09-17'], 'a recent run does not shrink the window');
  assert.deepEqual(w('2026-09-01'), ['2026-09-01', '2026-09-17'], 'after a long gap it reaches back to the last day covered');
  assert.deepEqual(w('2026-01-01'), ['2026-06-17', '2026-09-17'], 'capped at the maximum search range');
});

const thread = (url, relevanceScore, over = {}) => ({ title: `T ${relevanceScore}`, url, asksFor: 'help', summary: 's', whyRelevant: 'w', postedAt: '2026-09-16', relevanceScore, source: 'reddit', ...over });

/** In-memory jobs table plus fakes for everything the runner touches. */
const harness = ({ rows, searchImpl, sendImpl, existingLinks = [], clock = now }) => {
  const jobs = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls = { search: [], saved: [], logged: [], emails: [], runs: [], products: [] };
  const db = {
    selectOne: async (token, table, query) => { calls.products.push([token, query]); if (query.id !== `eq.${PID}`) throw new HttpError(404, 'Not found'); return { id: PID, name: 'FollowUp', description: 'Reminds owners to follow up' }; },
    select: async (token, table, query) => [...jobs.values()].filter((j) => j.status === 'active' && j.next_run_at <= query.next_run_at.slice(4)).sort((a, b) => (a.next_run_at < b.next_run_at ? -1 : 1)).slice(0, Number(query.limit)),
    update: async (token, table, query, patch) => {
      const j = jobs.get(query.id.slice(3));
      if (!j || (query.next_run_at && `eq.${j.next_run_at}` !== query.next_run_at) || (query.status && `eq.${j.status}` !== query.status)) throw new HttpError(404, 'Not found');
      Object.assign(j, patch);
      return { ...j };
    },
    insert: async (token, table, row) => { calls.runs.push([token, row]); return { id: 'run1', ...row }; },
  };
  const results = {
    save: async (token, productId, threads, { searchDate }) => {
      calls.saved.push([token, productId, threads.map((t) => t.url)]);
      return threads.map((t, i) => ({ id: `r${i}`, link: t.url, isNew: !existingLinks.includes(t.url) }));
    },
  };
  const searchLog = { record: async (token, entry) => { calls.logged.push([token, entry]); return true; } };
  const mailer = { configured: Boolean(sendImpl), send: async (msg) => { calls.emails.push(msg); return sendImpl(msg); } };
  const runner = createJobRunner({ config, db, jobs: createJobsService(db), results, searchLog, mailer, search: async (args) => { calls.search.push(args); return searchImpl(args); }, logger: { error: () => {}, warn: () => {} }, now: () => clock });
  return { runner, jobs, calls };
};

test('a due job searches the last day as the service role, stores only leads at or above minScore, emails the new ones, and books the next day', async () => {
  const { runner, jobs, calls } = harness({
    rows: [jobRow({ next_run_at: '2026-09-17T09:00:00+00:00' })],
    searchImpl: async () => ({ threads: [thread('https://www.reddit.com/r/a/comments/k1/x/', 0.95), thread('https://www.reddit.com/r/a/comments/k2/x/', 0.8), thread('https://www.reddit.com/r/a/comments/k3/x/', 0.79), thread('https://www.reddit.com/r/a/comments/k4/x/', 0.9)], meta: {}, diagnostics: { prompt: 'P' } }),
    sendImpl: async () => ({ id: 'msg1' }),
    existingLinks: ['https://www.reddit.com/r/a/comments/k4/x/'],
  });
  const outcomes = await runner.runDueJobs();
  assert.equal(outcomes.length, 1);
  const o = outcomes[0];
  assert.deepEqual([o.status, o.from, o.to, o.foundCount, o.leadCount, o.newLeadCount, o.emailStatus, o.completed], ['ok', '2026-09-10', '2026-09-17', 4, 3, 2, 'sent', false]);

  const search = calls.search[0];
  assert.deepEqual([search.productDescription, search.forums.map((f) => f.id), search.threads, search.from.toISOString(), search.to.toISOString()], ['Reminds owners to follow up', ['reddit'], 10, '2026-09-10T00:00:00.000Z', '2026-09-17T00:00:00.000Z']);
  assert.deepEqual(calls.products[0], ['service', { select: '*', id: `eq.${PID}` }], 'the product is read with the service key');
  assert.deepEqual(calls.saved, [['service', PID, ['https://www.reddit.com/r/a/comments/k1/x/', 'https://www.reddit.com/r/a/comments/k2/x/', 'https://www.reddit.com/r/a/comments/k4/x/']]], 'the 0.79 thread is not stored');
  assert.deepEqual([calls.logged[0][0], calls.logged[0][1].status, calls.logged[0][1].userId, calls.logged[0][1].returnedCount], ['service', 'ok', 'u1', 4]);

  assert.equal(calls.emails.length, 1);
  assert.equal(calls.emails[0].to, 'u@example.com');
  assert.equal(calls.emails[0].subject, '2 new leads for FollowUp');
  assert.match(calls.emails[0].text, /k1\/x/);
  assert.match(calls.emails[0].text, /k2\/x/);
  assert.doesNotMatch(calls.emails[0].text, /k4\/x/, 'a lead already stored under the product is not emailed again');

  const j = jobs.get('j1');
  assert.deepEqual([j.status, j.next_run_at, j.last_run_at, j.last_date_to, j.last_status, j.run_count], ['active', '2026-09-18T03:00:00.000Z', now.toISOString(), '2026-09-17', 'ok', 1], 'the next run snaps to the daily 03:00 slot');
  const [token, run] = calls.runs[0];
  assert.equal(token, 'service');
  assert.deepEqual([run.job_id, run.user_id, run.product_id, run.date_from, run.date_to, run.status, run.found_count, run.lead_count, run.new_lead_count, run.email_status], ['j1', 'u1', PID, '2026-09-10', '2026-09-17', 'ok', 4, 3, 2, 'sent']);

  assert.deepEqual(await runner.runDueJobs(), [], 'nothing is due until tomorrow');
});

test('no new leads means no email; the run is still recorded as skipped', async () => {
  const { runner, calls } = harness({ rows: [jobRow()], searchImpl: async () => ({ threads: [thread('https://www.reddit.com/r/a/comments/k1/x/', 0.5)], meta: {}, diagnostics: {} }), sendImpl: async () => ({}) });
  const [o] = await runner.runDueJobs();
  assert.deepEqual([o.status, o.leadCount, o.newLeadCount, o.emailStatus, calls.emails.length, calls.saved.length], ['ok', 0, 0, 'skipped', 0, 1]);
});

test('the last run on the end date completes the job', async () => {
  const { runner, jobs } = harness({ rows: [jobRow({ end_date: '2026-09-17' })], searchImpl: async () => ({ threads: [], meta: {}, diagnostics: {} }), sendImpl: async () => ({}) });
  const [o] = await runner.runDueJobs();
  assert.equal(o.completed, true);
  assert.equal(jobs.get('j1').status, 'completed');
});

test('a failed search is recorded on the job and the run; the next run picks up where the last good one ended', async () => {
  const { runner, jobs, calls } = harness({
    rows: [jobRow({ last_date_to: '2026-09-05' })],
    searchImpl: async () => { const e = new HttpError(429, 'Perplexity rate limit'); throw e; },
    sendImpl: async () => ({}),
  });
  const [o] = await runner.runDueJobs();
  assert.deepEqual([o.status, o.error, o.errorStatus, o.from, o.to], ['error', 'Perplexity rate limit', 429, '2026-09-05', '2026-09-17']);
  assert.deepEqual([calls.logged[0][1].status, calls.logged[0][1].error], ['error', 'Perplexity rate limit']);
  const j = jobs.get('j1');
  assert.deepEqual([j.status, j.last_status, j.last_error, j.last_date_to, j.run_count, j.next_run_at], ['active', 'error', 'Perplexity rate limit', '2026-09-05', 1, '2026-09-18T03:00:00.000Z']);
  assert.equal(calls.runs[0][1].status, 'error');
});

test('an email failure does not fail the run', async () => {
  const { runner, calls } = harness({ rows: [jobRow()], searchImpl: async () => ({ threads: [thread('https://www.reddit.com/r/a/comments/k1/x/', 0.9)], meta: {}, diagnostics: {} }), sendImpl: async () => { throw new HttpError(502, 'Resend down'); } });
  const [o] = await runner.runDueJobs();
  assert.deepEqual([o.status, o.newLeadCount, o.emailStatus, o.emailError, calls.runs[0][1].email_status], ['ok', 1, 'failed', 'Resend down', 'failed']);
});

test('without a mailer the leads are stored and the email is recorded as not configured', async () => {
  const { runner } = harness({ rows: [jobRow()], searchImpl: async () => ({ threads: [thread('https://www.reddit.com/r/a/comments/k1/x/', 0.9)], meta: {}, diagnostics: {} }), sendImpl: null });
  const [o] = await runner.runDueJobs();
  assert.deepEqual([o.status, o.newLeadCount, o.emailStatus], ['ok', 1, 'not_configured']);
});

test('more due jobs than the batch size all run, rather than being stranded until tomorrow', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => jobRow({ id: `j${i + 1}`, next_run_at: '2026-09-17T09:00:00+00:00' }));
  const { runner, jobs, calls } = harness({ rows, searchImpl: async () => ({ threads: [], meta: {}, diagnostics: {} }), sendImpl: async () => ({}) });
  const outcomes = await runner.runDueJobs();
  assert.equal(outcomes.length, 25, 'every due job ran, across batches of 20');
  assert.equal(calls.search.length, 25);
  assert.equal(new Set(outcomes.map((o) => o.jobId)).size, 25, 'each job ran exactly once');
  assert.ok([...jobs.values()].every((j) => j.next_run_at === '2026-09-18T03:00:00.000Z'), 'all booked into tomorrow\'s slot');
  assert.deepEqual(await runner.runDueJobs(), [], 'nothing is left due');
});

test('a job another runner already claimed is skipped, and a missing service key means nothing runs', async () => {
  const { runner, jobs, calls } = harness({ rows: [jobRow()], searchImpl: async () => ({ threads: [], meta: {}, diagnostics: {} }), sendImpl: async () => ({}) });
  const original = jobs.get('j1').next_run_at;
  const db = { select: async () => [{ ...jobRow(), next_run_at: original }] };
  jobs.get('j1').next_run_at = '2026-09-18T10:00:00+00:00'; // moved by someone else between due() and claim()
  const racing = createJobRunner({ config, db: { ...db, update: async () => { throw new HttpError(404, 'Not found'); } }, jobs: createJobsService({ ...db, update: async () => { throw new HttpError(404, 'Not found'); } }), results: {}, searchLog: {}, mailer: {}, search: async () => { throw new Error('should not search'); }, logger: { error: () => {}, warn: () => {} }, now: () => now });
  assert.deepEqual(await racing.runDueJobs(), []);
  assert.equal(calls.search.length, 0);

  const warnings = [];
  const keyless = createJobRunner({ config: loadConfig({}), db: {}, jobs: {}, results: {}, searchLog: {}, mailer: {}, logger: { warn: (m) => warnings.push(m), error: () => {} } });
  assert.deepEqual(await keyless.runDueJobs(), []);
  assert.deepEqual(await keyless.runDueJobs(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SUPABASE_SERVICE_ROLE_KEY/);
});

test('start() is off when disabled, and starting twice does not double the timers', () => {
  const off = createJobRunner({ config: loadConfig({ SEARCH_JOBS_ENABLED: 'false' }), db: {}, jobs: {}, results: {}, searchLog: {}, mailer: {} });
  assert.equal(off.start(), false);
  const on = createJobRunner({ config: loadConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k' }), db: {}, jobs: { due: async () => [] }, results: {}, searchLog: {}, mailer: {} });
  assert.equal(on.start({ firstDelayMs: 10_000_000 }), true);
  assert.equal(on.start(), false);
  on.stop();
  assert.equal(on.start({ firstDelayMs: 10_000_000 }), true, 'stop() releases it again');
  on.stop();
});

test('the daily timer is scheduled to the slot itself, so it cannot drift off the hour', async () => {
  const waits = [];
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); return realTimeout(() => {}, 0); };
  try {
    const runner = createJobRunner({
      config: loadConfig({ SUPABASE_SERVICE_ROLE_KEY: 'k', SEARCH_JOBS_RUN_AT_HOUR: '3' }),
      db: {}, jobs: { due: async () => [] }, results: {}, searchLog: {}, mailer: {},
      now: () => new Date('2026-09-17T14:00:00Z'),
    });
    runner.start({ firstDelayMs: 10_000 });
    assert.deepEqual(waits, [10_000, 13 * 60 * 60 * 1000], 'a boot catch-up, then 13 hours until 03:00');
    runner.stop();
  } finally {
    globalThis.setTimeout = realTimeout;
  }
});

// ---------- routes ----------

const fakeVerify = async (token) => {
  if (token === 'good') return { id: 'user-1', email: 'u@example.com', role: 'authenticated', isAnonymous: false };
  if (token === 'noemail') return { id: 'user-2', email: null, role: 'authenticated', isAnonymous: false };
  throw new HttpError(401, 'Invalid token');
};
const fakeProducts = { get: async (token, id) => { if (id !== PID) throw new HttpError(404, 'Not found'); return { id, name: 'FollowUp', description: 'd' }; } };
const store = [];
const writes = [];
const fakeJobs = {
  create: async (token, user, input) => { writes.push(['create', token]); const job = { id: randomUUID(), ...input, forums: input.forums.map((f) => f.id), userId: user.id, status: 'active', runCount: 0 }; store.push(job); return job; },
  list: async (token, { productId, status }) => store.filter((j) => (!productId || j.productId === productId) && (!status || j.status === status)),
  get: async (token, id) => { const j = store.find((x) => x.id === id); if (!j) throw new HttpError(404, 'Not found'); return j; },
  countActive: async () => store.filter((j) => j.status === 'active').length,
  cancel: async (token, id, opts) => { writes.push(['cancel', token, opts]); const j = await fakeJobs.get(token, id); if (j.status === 'active') j.status = 'cancelled'; return j; },
  listRuns: async (token, jobId, { limit, offset }) => ({ runs: [{ id: 'run1', jobId, status: 'ok' }].slice(offset, offset + limit), total: 1 }),
};
let server; let base;
before(async () => {
  server = createApp({ config, verify: fakeVerify, products: fakeProducts, jobs: fakeJobs }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const headers = (token = 'good') => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const post = (body, token) => fetch(`${base}/api/jobs`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
const today = new Date().toISOString().slice(0, 10);

test('POST /api/jobs requires auth, checks the product, and returns 201 with the job', async () => {
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await post({ forum: 'reddit', endDate: today })).status, 400, 'productId required');
  assert.equal((await post({ productId: OTHER, forum: 'reddit', endDate: today })).status, 404);
  assert.equal((await post({ productId: PID, forum: 'reddit' })).status, 400, 'endDate required');
  const noEmail = await post({ productId: PID, forum: 'reddit', endDate: today }, 'noemail');
  assert.equal(noEmail.status, 400);
  assert.match((await noEmail.json()).error.message, /email/);

  const ok = await post({ productId: PID, forum: ['reddit', 'hackernews'], endDate: today, threads: 5 });
  assert.equal(ok.status, 201);
  const booked = store[0].nextRunAt;
  assert.equal(booked.toISOString().slice(11), '03:00:00.000Z', 'a new job is booked into the daily 03:00 slot, not at the moment it was created');
  assert.ok(booked > new Date() && booked - new Date() <= 24 * 60 * 60 * 1000, 'the next slot, within a day');
  const { job } = await ok.json();
  assert.deepEqual([job.productId, job.email, job.forums, job.threads, job.minScore, job.startDate, job.endDate, job.status, job.userId], [PID, 'u@example.com', ['reddit', 'hackernews'], 5, 0.8, today, today, 'active', 'user-1']);

  const custom = await post({ productId: PID, forum: 'x', endDate: today, minScore: 0.9, email: 'other@example.com' });
  assert.equal(custom.status, 201);
  assert.deepEqual([(await custom.json()).job.minScore, store[1].email], [0.9, 'other@example.com']);
});

test('POST /api/jobs enforces the active job limit', async () => {
  const res = await post({ productId: PID, forum: 'reddit', endDate: today });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /2 active jobs/);
  assert.deepEqual(body.error.details, { activeJobs: 2, maxActiveJobs: 2 });
});

test('GET /api/jobs lists with filters; GET /api/jobs/:id fetches or 404s', async () => {
  assert.equal((await (await fetch(`${base}/api/jobs`, { headers: headers() })).json()).jobs.length, 2);
  assert.equal((await (await fetch(`${base}/api/jobs?status=cancelled`, { headers: headers() })).json()).jobs.length, 0);
  assert.equal((await fetch(`${base}/api/jobs?status=paused`, { headers: headers() })).status, 400);
  assert.equal((await fetch(`${base}/api/jobs/${OTHER}`, { headers: headers() })).status, 404);
  assert.equal((await fetch(`${base}/api/jobs/not-a-uuid`, { headers: headers() })).status, 400);
});

test('DELETE /api/jobs/:id cancels, and GET /api/jobs/:id/runs pages the history', async () => {
  const id = store[0].id;
  const runs = await fetch(`${base}/api/jobs/${id}/runs?limit=10`, { headers: headers() });
  assert.equal(runs.status, 200);
  assert.deepEqual(await runs.json(), { jobId: id, runs: [{ id: 'run1', jobId: id, status: 'ok' }], count: 1, total: 1, limit: 10, offset: 0 });

  const del = await fetch(`${base}/api/jobs/${id}`, { method: 'DELETE', headers: headers() });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).job.status, 'cancelled');
  assert.equal((await (await fetch(`${base}/api/jobs?status=cancelled`, { headers: headers() })).json()).jobs.length, 1);
  const again = await post({ productId: PID, forum: 'reddit', endDate: today });
  assert.equal(again.status, 201, 'cancelling frees a slot');
});

test('job writes use the service key; the user token only proves ownership', async () => {
  assert.ok(writes.length >= 2);
  for (const [kind, token, opts] of writes) {
    if (kind === 'create') assert.equal(token, 'service', 'jobs are created with the service key');
    if (kind === 'cancel') {
      assert.equal(token, 'good', 'the user token is used to read the job, which proves it is theirs');
      assert.deepEqual(opts, { serviceToken: 'service', userId: 'user-1' });
    }
  }
});

test('without the service key, creating or cancelling a job is a 500 that names the missing setting', async () => {
  const noKey = loadConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: 'anon' });
  const s2 = createApp({ config: noKey, verify: fakeVerify, products: fakeProducts, jobs: fakeJobs }).listen(0);
  await new Promise((r) => s2.once('listening', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const created = await fetch(`${b2}/api/jobs`, { method: 'POST', headers: headers(), body: JSON.stringify({ productId: PID, forum: 'reddit', endDate: today }) });
    assert.equal(created.status, 500);
    assert.match((await created.json()).error.message, /SUPABASE_SERVICE_ROLE_KEY/);
    const cancelled = await fetch(`${b2}/api/jobs/${store[0].id}`, { method: 'DELETE', headers: headers() });
    assert.equal(cancelled.status, 500);
  } finally {
    s2.close();
  }
});

// ---------- secret key headers ----------

test('a new-format secret key goes in the apikey header only; other tokens go as a bearer beside the anon key', async () => {
  const captured = [];
  const db = createSupabaseRest(config.supabase, { fetchImpl: async (url, init) => { captured.push(init.headers); return new Response('[]', { status: 200 }); } });
  await db.select('sb_secret_abc123', 'search_jobs', { select: '*' });
  await db.select('eyJhbGciOiJIUzI1NiJ9.legacy.sig', 'search_jobs', { select: '*' });
  await db.select('user-access-token', 'search_jobs', { select: '*' });
  assert.equal(captured[0].apikey, 'sb_secret_abc123');
  assert.ok(!('Authorization' in captured[0]), 'the gateway rejects a secret key sent as a bearer token');
  for (const h of captured.slice(1)) {
    assert.equal(h.apikey, 'anon');
    assert.match(h.Authorization, /^Bearer /);
  }
});
