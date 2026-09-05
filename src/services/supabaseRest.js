import { HttpError } from '../errors.js';

/**
 * Minimal client for Supabase's PostgREST endpoint, acting as the calling user.
 *
 * Requests carry the user's own access token, so Postgres row-level security
 * decides what they can see and change. The server never needs a privileged key.
 */
export function createSupabaseRest(supabaseConfig, { fetchImpl = fetch } = {}) {
  const { restUrl, anonKey } = supabaseConfig;

  const request = async ({ token, method = 'GET', table, query = {}, body, prefer, single = false }) => {
    if (!restUrl || !anonKey) {
      throw new HttpError(500, 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY; database access is not configured');
    }
    const url = new URL(`${restUrl}/${table}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);

    const headers = {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      Accept: single ? 'application/vnd.pgrst.object+json' : 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;

    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    } catch (cause) {
      throw new HttpError(502, 'Could not reach the database', { reason: cause?.message });
    }

    let data = null;
    if (res.status !== 204) {
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text };
        }
      }
    }
    if (res.ok) return { data, headers: res.headers };

    const message = data?.message ?? data?.hint ?? `Database request failed with HTTP ${res.status}`;
    if (res.status === 401) throw new HttpError(401, 'Database rejected the session token', { reason: message });
    if (res.status === 403) throw new HttpError(403, 'Not allowed', { reason: message });
    if (res.status === 404 || (res.status === 406 && single)) throw new HttpError(404, 'Not found');
    if (res.status === 409) throw new HttpError(409, message, { code: data?.code });
    if (res.status === 400 || res.status === 422) throw new HttpError(400, message, { code: data?.code });
    throw new HttpError(502, `Database request failed with HTTP ${res.status}`, { reason: message });
  };

  /** Parses "0-49/123" from Content-Range into a total, or null if unknown. */
  const totalFromRange = (headers) => {
    const m = (headers?.get?.('content-range') ?? '').match(/\/(\d+|\*)$/);
    return m && m[1] !== '*' ? Number(m[1]) : null;
  };

  return {
    insert: async (token, table, row) =>
      (await request({ token, method: 'POST', table, body: row, prefer: 'return=representation', single: true })).data,

    /** Insert rows, updating existing ones that collide on `onConflict` columns. Returns the stored rows. */
    upsert: async (token, table, rows, { onConflict }) =>
      (await request({ token, method: 'POST', table, query: { on_conflict: onConflict }, body: rows, prefer: 'resolution=merge-duplicates,return=representation' })).data ?? [],

    select: async (token, table, query) => (await request({ token, table, query })).data ?? [],

    selectOne: async (token, table, query) => (await request({ token, table, query, single: true })).data,

    /** Like select, but also returns the total row count ignoring limit/offset. */
    selectPage: async (token, table, query) => {
      const { data, headers } = await request({ token, table, query, prefer: 'count=exact' });
      return { rows: data ?? [], total: totalFromRange(headers) ?? (data ?? []).length };
    },
  };
}
