#!/usr/bin/env node
/**
 * Removes a forum post on request (Privacy Policy, Section 8): deletes every stored lead for it,
 * under every product of every user, and adds it to removed_threads so no search stores it again.
 *
 *   npm run remove-thread -- --link https://www.reddit.com/r/x/comments/abc123/title/ --dry-run
 *   npm run remove-thread -- --link https://www.reddit.com/r/x/comments/abc123/title/
 *
 * Rows are matched by canonical key, so every way of writing the link (www, a different Reddit slug,
 * tracking parameters) counts as the same post. --dry-run lists what would be deleted and changes
 * nothing. Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env.
 *
 * Search logs (search_requests) may still hold the link; they are purged within about five weeks.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createSupabaseRest } from '../src/services/supabaseRest.js';
import { threadKey } from '../src/services/results.js';

const { values } = parseArgs({ options: { link: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
if (!values.link) {
  console.error('usage: npm run remove-thread -- --link <post url> [--dry-run]');
  process.exit(2);
}

const key = threadKey(values.link);
if (!key) {
  console.error(`not an http(s) link: ${values.link}`);
  process.exit(2);
}

const config = loadConfig();
const serviceToken = config.supabase.serviceRoleKey;
if (!config.supabase.restUrl || !config.supabase.anonKey || !serviceToken) {
  console.error('SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set in .env.');
  process.exit(2);
}
const db = createSupabaseRest(config.supabase);

// A loose text match narrows the candidates; the canonical key then decides which are the same post.
const pattern = (() => {
  const [kind, id] = key.split(':');
  if (kind === 'reddit') return `*comments/${id}*`;
  if (kind === 'x') return `*status/${id}*`;
  if (kind === 'hn') return `*id=${id}*`;
  // Otherwise the key is host + path (+ query); match on the path, or the host if there is none.
  const slash = key.indexOf('/');
  return `*${(slash === -1 ? key : key.slice(slash)).split('?')[0]}*`;
})();

try {
  const candidates = await db.select(serviceToken, 'search_results', { select: 'id,product_id,link,created_at', link: `ilike.${pattern}` });
  const matches = candidates.filter((r) => threadKey(r.link) === key);

  console.log(`post key: ${key}`);
  console.log(`${matches.length} stored lead${matches.length === 1 ? '' : 's'} for this post:`);
  for (const r of matches) console.log(`  ${r.id}  product ${r.product_id}  ${r.link}`);

  if (values['dry-run']) {
    console.log('dry run: nothing changed.');
    process.exit(0);
  }

  // Suppress first, so a search running right now cannot store it again after the delete.
  await db.upsert(serviceToken, 'removed_threads', [{ canonical_key: key }], { onConflict: 'canonical_key' });
  console.log('added to removed_threads: searches will not store it again.');

  if (matches.length > 0) {
    const ids = matches.map((r) => `"${r.id}"`).join(',');
    const deleted = await db.remove(serviceToken, 'search_results', { id: `in.(${ids})` });
    console.log(`deleted ${deleted.length} lead${deleted.length === 1 ? '' : 's'}.`);
  }
  console.log('done. Record it in the removal log and reply to the requester.');
} catch (err) {
  console.error(`failed: ${err.message}${err.details?.reason ? ` (${err.details.reason})` : ''}`);
  process.exit(1);
}
