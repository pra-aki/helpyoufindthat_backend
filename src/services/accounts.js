import { HttpError } from '../errors.js';

/**
 * Account deletion through Supabase Auth's admin API, which only accepts the service key; the
 * browser can never delete a user itself.
 *
 * Deleting the user removes everything they own, since every table cascades from auth.users,
 * except their Terms of Service acceptances, which are kept and marked by a database trigger.
 *
 * @param {object} supabaseConfig  config.supabase from src/config.js
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 */
export function createAccountsService(supabaseConfig, { fetchImpl = fetch } = {}) {
  const { url, serviceRoleKey } = supabaseConfig;

  return {
    /** Permanently deletes the user. Resolves to { alreadyGone } when the user did not exist. */
    async deleteUser(userId) {
      if (!url || !serviceRoleKey) {
        throw new HttpError(500, 'Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; account deletion is not configured');
      }
      // A new-format secret key goes in the apikey header only, and the gateway turns it into the
      // service role; the legacy service_role key is itself a JWT, so it also goes as the bearer.
      const headers = { apikey: serviceRoleKey };
      if (!serviceRoleKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${serviceRoleKey}`;

      let res;
      try {
        res = await fetchImpl(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(15_000) });
      } catch (cause) {
        throw new HttpError(502, 'Could not reach the authentication service', { reason: cause?.message });
      }
      // A user who no longer exists is already deleted, which is what the caller asked for.
      if (res.status === 404) return { alreadyGone: true };
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new HttpError(502, `Account deletion failed with HTTP ${res.status}`, { reason: data?.msg ?? data?.message ?? data?.error_description ?? null });
      }
      return { alreadyGone: false };
    },
  };
}
