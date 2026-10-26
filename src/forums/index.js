/**
 * Forum registry.
 *
 * To add a forum: create src/forums/<name>.js exporting an object with
 *   id          - stable slug used in API requests (lowercase, hyphenated)
 *   name        - display name
 *   aliases     - other spellings accepted in requests
 *   domains     - domains passed to Perplexity's search_domain_filter
 *   isThreadUrl - (URL) => boolean, filters out index/profile pages from results
 * then import it here and append it to the `forums` array.
 */
import reddit from './reddit.js';
import facebookGroups from './facebookGroups.js';
import quora from './quora.js';
import linkedinGroups from './linkedinGroups.js';
import hackerNews from './hackerNews.js';
import x from './x.js';

export const forums = Object.freeze([reddit, facebookGroups, quora, linkedinGroups, hackerNews, x]);

// The forums a search or job may name, matching what the app offers. Hacker News and X stay registered
// so leads already stored from them still display and filter, but new searches cannot reach them.
const SEARCHABLE_IDS = ['reddit', 'facebook-groups', 'quora', 'linkedin-groups'];
export const searchableForums = Object.freeze(forums.filter((f) => SEARCHABLE_IDS.includes(f.id)));

export const normalizeForumId = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

const lookup = new Map();
for (const forum of forums) {
  for (const key of [forum.id, ...(forum.aliases ?? [])]) {
    const normalized = normalizeForumId(key);
    if (lookup.has(normalized) && lookup.get(normalized) !== forum) {
      throw new Error(`Forum alias "${normalized}" is claimed by both "${lookup.get(normalized).id}" and "${forum.id}"`);
    }
    lookup.set(normalized, forum);
  }
}

export function getForum(value) {
  return lookup.get(normalizeForumId(value)) ?? null;
}

export function listForums(list = forums) {
  return list.map(({ id, name, aliases, domains }) => ({ id, name, aliases: [...(aliases ?? [])], domains: [...domains] }));
}
