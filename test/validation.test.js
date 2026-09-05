import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { parseSearchRequest, parseForums, parseDateRange, isoDay } from '../src/validation.js';

const now = new Date('2026-09-04T15:30:00Z');

const config = loadConfig({});

test('applies defaults x=10, y=1 when not specified', () => {
  const r = parseSearchRequest({ productDescription: 'An app that finds parking', forum: 'reddit' }, config, { now });
  assert.equal(r.threads, 10);
  assert.equal(r.days, 1);
  assert.equal(isoDay(r.from), '2026-09-03');
  assert.equal(isoDay(r.to), '2026-09-04');
  assert.deepEqual(r.forums.map((f) => f.id), ['reddit']);
  assert.equal(r.productDescription, 'An app that finds parking');
});

test('accepts x/y and snake_case spellings, coercing query-string numbers', () => {
  const r = parseSearchRequest({ product_description: 'desc', forum_name: 'Hacker News', x: '5', y: '30' }, config, { now });
  assert.equal(r.threads, 5);
  assert.equal(r.days, 30);
  assert.equal(isoDay(r.from), '2026-08-05');
  assert.deepEqual(r.forums.map((f) => f.id), ['hackernews']);
});

test('forum accepts a list, a comma-separated string, or "all", de-duplicating aliases', () => {
  const ids = (input) => parseForums(input).map((f) => f.id);
  assert.deepEqual(ids(['reddit', 'Hacker News', 'x']), ['reddit', 'hackernews', 'x']);
  assert.deepEqual(ids('reddit, hacknews ,twitter'), ['reddit', 'hackernews', 'x']);
  assert.deepEqual(ids(['reddit', 'Reddit', 'reddit']), ['reddit']);
  assert.deepEqual(ids('all'), ['reddit', 'facebook-groups', 'quora', 'linkedin-groups', 'hackernews', 'x']);
  assert.deepEqual(ids(['reddit', 'ALL']), ['reddit', 'facebook-groups', 'quora', 'linkedin-groups', 'hackernews', 'x']);
  const r = parseSearchRequest({ productDescription: 'desc', forums: ['quora', 'x'] }, config);
  assert.deepEqual(r.forums.map((f) => f.id), ['quora', 'x']);
});

test('forum list rejects empty lists, non-strings, and unknown entries', () => {
  assert.throws(() => parseForums([]), (e) => e.status === 400 && /required/.test(e.message));
  assert.throws(() => parseForums(['reddit', 42]), (e) => e.status === 400 && /list of strings/.test(e.message));
  assert.throws(() => parseForums(['reddit', 'myspace']), (e) => e.status === 400 && /Unsupported forum "myspace"/.test(e.message) && e.details.supported.includes('all'));
});

const rejects = (body, pattern) =>
  assert.throws(() => parseSearchRequest(body, config), (err) => err.status === 400 && pattern.test(err.message));

test('rejects missing or invalid input with 400s', () => {
  rejects({ forum: 'reddit' }, /productDescription/);
  rejects({ productDescription: '   ', forum: 'reddit' }, /productDescription/);
  rejects({ productDescription: 'desc' }, /forum/);
  rejects({ productDescription: 'desc', forum: 'myspace' }, /Unsupported forum/);
  rejects({ productDescription: 'desc', forum: 'reddit', threads: 0 }, /threads/);
  rejects({ productDescription: 'desc', forum: 'reddit', threads: 2.5 }, /threads/);
  rejects({ productDescription: 'desc', forum: 'reddit', threads: 999 }, /at most/);
  rejects({ productDescription: 'desc', forum: 'reddit', days: 'soon' }, /days/);
  rejects({ productDescription: 'x'.repeat(2001), forum: 'reddit' }, /at most 2000/);
});

test('unsupported forum error lists the supported ids', () => {
  try {
    parseSearchRequest({ productDescription: 'desc', forum: 'nope' }, config);
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err.details.supported.includes('reddit'));
  }
});

const range = (source) => {
  const r = parseDateRange(source, config, { now });
  return [isoDay(r.from), isoDay(r.to), r.days];
};

test('date range: explicit from/to, from only, to only, and aliases', () => {
  assert.deepEqual(range({ from: '2026-08-01', to: '2026-08-31' }), ['2026-08-01', '2026-08-31', 30]);
  assert.deepEqual(range({ from: '2026-08-20' }), ['2026-08-20', '2026-09-04', 15]);
  assert.deepEqual(range({ to: '2026-08-31', days: 7 }), ['2026-08-24', '2026-08-31', 7]);
  assert.deepEqual(range({ startDate: '2026-09-01', endDate: '2026-09-02' }), ['2026-09-01', '2026-09-02', 1]);
  assert.deepEqual(range({ start_date: '2026-09-04T10:00:00Z', end_date: '2026-09-04' }), ['2026-09-04', '2026-09-04', 0]);
});

test('date range: rejects bad dates, future end, reversed range, and spans over a year', () => {
  const bad = (source, re) => assert.throws(() => parseDateRange(source, config, { now }), (e) => e.status === 400 && re.test(e.message));
  bad({ from: 'yesterday' }, /"from" must be a date/);
  bad({ to: '2026-09-05' }, /future/);
  bad({ from: '2026-09-02', to: '2026-09-01' }, /on or before/);
  bad({ from: '2025-09-03', to: '2026-09-04' }, /exceed 365 days/);
  assert.deepEqual(range({ from: '2025-09-04', to: '2026-09-04' }), ['2025-09-04', '2026-09-04', 365], 'exactly one year is allowed');
  bad({ days: 400 }, /at most 365/);
});
