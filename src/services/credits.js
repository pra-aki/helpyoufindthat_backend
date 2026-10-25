import { HttpError } from '../errors.js';

/**
 * User credits, tracked as two balances: free (the 100 granted when an account is created, which
 * never expire) and paid. Free credits are spent first, and a refund returns credits to the balance
 * they came from, paid first. Every account starts with 100 free credits. A search costs one credit per 10 leads requested, per forum; a scheduled job costs one
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
    freeDelta: row.free_delta ?? row.delta,
    paidDelta: row.paid_delta ?? 0,
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

  const balances = (out) => ({ balance: Number(out?.balance ?? 0), free: Number(out?.free ?? 0), paid: Number(out?.paid ?? 0) });

  return {
    /** The user's balances, { balance, free, paid }, opening their account with the sign-up grant if it is missing. */
    async balance(userId) {
      return balances(await db.rpc(service(), 'credit_balances', { p_user: userId }));
    },

    /**
     * Spends `amount`, free credits first, if the total covers it; never overdraws. Resolves to a
     * charge: { charged, balance, free, paid, freeSpent, paidSpent }, which refund() takes so that
     * credits go back where they came from.
     */
    async spend(userId, amount, reason, details = null) {
      const out = await db.rpc(service(), 'spend_credits', { p_user: userId, p_amount: amount, p_reason: reason, p_details: details });
      return {
        charged: out?.charged === true,
        ...balances(out),
        freeSpent: Number(out?.freeSpent ?? 0),
        paidSpent: Number(out?.paidSpent ?? 0),
        freeRefunded: 0,
        paidRefunded: 0,
      };
    },

    /**
     * Gives back `amount` of what `charge` spent, paid credits first, since those are the user's
     * money. Notes the refund on the charge, so a second refund of the same charge takes only what
     * is left. Resolves to the new { balance, free, paid }.
     */
    async refund(userId, charge, amount, details = null) {
      const paid = Math.min(amount, charge.paidSpent - charge.paidRefunded);
      const free = Math.min(amount - paid, charge.freeSpent - charge.freeRefunded);
      if (paid + free <= 0) return { balance: charge.balance, free: charge.free, paid: charge.paid };
      const out = balances(await db.rpc(service(), 'refund_credits', { p_user: userId, p_free: free, p_paid: paid, p_details: details }));
      charge.paidRefunded += paid;
      charge.freeRefunded += free;
      return out;
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
