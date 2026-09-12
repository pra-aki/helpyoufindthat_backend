import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forums, getForum, listForums } from '../src/forums/index.js';

test('all six launch forums are registered', () => {
  assert.deepEqual(
    listForums().map((f) => f.id),
    ['reddit', 'facebook-groups', 'quora', 'linkedin-groups', 'hackernews', 'x'],
  );
});

test('lookup is case-insensitive and accepts aliases and spaces', () => {
  assert.equal(getForum('Reddit').id, 'reddit');
  assert.equal(getForum('Facebook Groups').id, 'facebook-groups');
  assert.equal(getForum('hacknews').id, 'hackernews');
  assert.equal(getForum('HN').id, 'hackernews');
  assert.equal(getForum('twitter').id, 'x');
  assert.equal(getForum('LinkedIn').id, 'linkedin-groups');
  assert.equal(getForum('myspace'), null);
  assert.equal(getForum(undefined), null);
});

test('every forum has the fields the search service relies on', () => {
  for (const forum of forums) {
    assert.ok(forum.id && forum.name, `${forum.id} needs id and name`);
    assert.ok(Array.isArray(forum.domains) && forum.domains.length > 0, `${forum.id} needs domains`);
    assert.ok(typeof forum.voice === 'string' && forum.voice.length > 20, `${forum.id} needs a voice description, kept for when reply drafting returns`);
    assert.equal(typeof forum.isThreadUrl, 'function');
  }
});

test('isThreadUrl distinguishes threads from index pages', () => {
  const ok = (id, href) => assert.ok(getForum(id).isThreadUrl(new URL(href)), `${id} should accept ${href}`);
  const no = (id, href) => assert.ok(!getForum(id).isThreadUrl(new URL(href)), `${id} should reject ${href}`);
  ok('reddit', 'https://www.reddit.com/r/smallbusiness/comments/abc123/looking_for_a_tool/');
  no('reddit', 'https://www.reddit.com/r/smallbusiness/');
  ok('hackernews', 'https://news.ycombinator.com/item?id=41234567');
  no('hackernews', 'https://news.ycombinator.com/ask');
  ok('x', 'https://x.com/someone/status/1234567890');
  no('x', 'https://x.com/someone');
  ok('facebook-groups', 'https://www.facebook.com/groups/123/posts/456/');
  no('facebook-groups', 'https://www.facebook.com/groups/123/');
  ok('quora', 'https://www.quora.com/What-is-the-best-tool-for-X');
  no('quora', 'https://www.quora.com/profile/Someone');
  ok('linkedin-groups', 'https://www.linkedin.com/posts/someone_activity-123');
  no('linkedin-groups', 'https://www.linkedin.com/in/someone');
});
