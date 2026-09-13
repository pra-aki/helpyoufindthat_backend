/**
 * Records one row per search in public.search_requests: what was asked, the exact
 * prompt and settings sent to Perplexity, and what happened to the results. A
 * scheduled job in the database deletes rows older than 30 days.
 *
 * Logging never fails a search. A write error goes to the server log and is swallowed.
 */

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
const int = (value) => (Number.isInteger(value) ? value : null);

/** Maps a log entry to table columns, capping anything that could grow large. Exported for testing. */
export function toSearchRequestRow(entry) {
  const d = entry.diagnostics ?? {};
  return {
    product_id: entry.productId,
    user_id: entry.userId,
    forums: entry.forums,
    threads_requested: entry.threadsRequested,
    date_from: entry.from,
    date_to: entry.to,
    status: entry.status,
    error: text(entry.error, 2000),
    error_status: int(entry.errorStatus),
    prompt: text(d.prompt, 20000),
    settings: d.settings ?? null,
    raw_result_count: int(d.rawResultCount),
    search_result_urls: Array.isArray(d.searchResultUrls) ? d.searchResultUrls.slice(0, 200).map((u) => String(u).slice(0, 500)) : null,
    model_thread_count: int(d.modelThreadCount),
    used_fallback: typeof d.usedFallback === 'boolean' ? d.usedFallback : null,
    returned_count: int(entry.returnedCount),
    dropped: Array.isArray(d.dropped) ? d.dropped.slice(0, 200) : null,
    problem: text(d.problem, 1000),
    usage: d.usage ?? null,
    duration_ms: Number.isFinite(d.durationMs) ? Math.round(d.durationMs) : null,
  };
}

/**
 * @param {object} db  Supabase REST client (src/services/supabaseRest.js); writes run as the calling user
 * @param {object} [options]
 * @param {{ error: Function }} [options.logger]
 */
export function createSearchLogService(db, { logger = console } = {}) {
  return {
    /** Returns true when the row was written, false when the write failed. Never throws. */
    async record(token, entry) {
      try {
        await db.insert(token, 'search_requests', toSearchRequestRow(entry));
        return true;
      } catch (err) {
        logger.error('search log write failed:', err?.message ?? err);
        return false;
      }
    },
  };
}
