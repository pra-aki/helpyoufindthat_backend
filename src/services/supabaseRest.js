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
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

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

    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
    if (res.ok) return data;

    const message = data?.message ?? data?.hint ?? `Database request failed with HTTP ${res.status}`;
    if (res.status === 401) throw new HttpError(401, 'Database rejected the session token', { reason: message });
    if (res.status === 403) throw new HttpError(403, 'Not allowed', { reason: message });
    if (res.status === 404 || (res.status === 406 && single)) throw new HttpError(404, 'Not found');
    if (res.status === 409) throw new HttpError(409, message, { code: data?.code });
    if (res.status === 400 || res.status === 422) throw new HttpError(400, message, { code: data?.code });
    throw new HttpError(502, `Database request failed with HTTP ${res.status}`, { reason: message });
  };

  return {
    insert: (token, table, row) => request({ token, method: 'POST', table, body: row, prefer: 'return=representation', single: true }),
    select: (token, table, query) => request({ token, table, query }),
    selectOne: (token, table, query) => request({ token, table, query, single: true }),
  };
}
