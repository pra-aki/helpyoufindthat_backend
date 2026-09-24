import { HttpError } from '../errors.js';

/**
 * User credits. Every account starts with 100 (granted by the database when the account is
 * created). A search costs one credit per 10 leads requested, per forum; a scheduled job costs one
 * credit per forum each day it runs.
 *
 * Users can read their balance and history but never change them: every change goes through
 * database functions that only the service role may execute, called here after the route or the
 * job runner has established whose credits they are. Reads of the history use the user's own
 * token, so row-level security scopes them.
 */

export const LEADS_PER_CREDIT = 10;
export const SIGNUP_CREDITS = 100; // granted by public.ensure_user_credits; documented here for the API

/** A search's cost: one credit per 10 leads requested (rounded up), for each forum searched. */
export const searchCost = ({ threads, forumCount }) => Math.ceil(threads / LEADS_PER_CREDIT) * forumCount;

/** What one forum of a search costs, for refunding a forum that failed. */
export const searchCostPerForum = ({ threads }) => Math.ceil(threads / LEADS_PER_CREDIT);

/** A scheduled run's cost: one credit per forum, whatever the job's lead count or search window. */
export const jobRunCost = ({ forumCount }) => forumCount;

const transactionToApi = (row) =>
  row && {
    id: row.id,
    delta: row.delta,
    balanceAfter: row.balance_after,
    reason: row.reason,
    details: row.details ?? null,
    createdAt: row.created_at,
  };

/**
 * @param {object} db  Supabase REST client
 * @param {object} options
 * @param {string} options.serviceToken  the service key; without it no credit can be read or spent
 */
export function createCreditsService(db, { serviceToken }) {
  const service = () => {
    if (!serviceToken) throw new HttpError(500, 'Server is missing SUPABASE_SERVICE_ROLE_KEY; credits are not configured');
    return serviceToken;
  };

  return {
    /** The user's balance, opening their account with the signup grant if it is somehow missing. */
    async balance(userId) {
      return Number(await db.rpc(service(), 'ensure_user_credits', { p_user: userId }));
    },

    /** Spends `amount` if the balance covers it. Resolves to { charged, balance }; never overdraws. */
    async spend(userId, amount, reason, details = null) {
      const out = await db.rpc(service(), 'spend_credits', { p_user: userId, p_amount: amount, p_reason: reason, p_details: details });
      return { charged: out?.charged === true, balance: Number(out?.balance ?? 0) };
    },

    /** Gives back credits for work that failed. Resolves to the new balance. */
    async refund(userId, amount, details = null) {
      return Number(await db.rpc(service(), 'refund_credits', { p_user: userId, p_amount: amount, p_details: details }));
    },

    /** The caller's own ledger, newest first, read with their token. */
    async history(token, { limit, offset }) {
      const { rows, total } = await db.selectPage(token, 'credit_transactions', {
        select: '*',
        order: 'created_at.desc',
        limit: String(limit),
        offset: String(offset),
      });
      return { transactions: rows.map(transactionToApi), total };
    },
  };
}
