import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { parseSearchRequest } from '../src/validation.js';

const config = loadConfig({});

test('applies defaults x=10, y=1 when not specified', () => {
  const r = parseSearchRequest({ productDescription: 'An app that finds parking', forum: 'reddit' }, config);
  assert.equal(r.threads, 10);
  assert.equal(r.days, 1);
  assert.equal(r.forum.id, 'reddit');
  assert.equal(r.productDescription, 'An app that finds parking');
});

test('accepts x/y and snake_case spellings, coercing query-string numbers', () => {
  const r = parseSearchRequest({ product_description: 'desc', forum_name: 'Hacker News', x: '5', y: '30' }, config);
  assert.equal(r.threads, 5);
  assert.equal(r.days, 30);
  assert.equal(r.forum.id, 'hackernews');
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
