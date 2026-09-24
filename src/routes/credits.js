import { Router } from 'express';
import { parseResultsQuery } from '../validation.js';
import { LEADS_PER_CREDIT, SIGNUP_CREDITS } from '../services/credits.js';

const bearer = (req) => (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/**
 * @param {object} deps
 * @param {object} deps.credits      credits service (src/services/credits.js)
 * @param {Function[]} deps.protect  auth middleware
 */
export function creditsRouter({ credits, protect }) {
  const router = Router();

  // GET /api/credits?limit=20&offset=0  -> the caller's balance, the pricing, and their ledger, newest first
  router.get('/credits', ...protect, async (req, res) => {
    const { limit, offset } = parseResultsQuery({ limit: req.query.limit, offset: req.query.offset }, { defaultLimit: 20, maxLimit: 100 });
    const balance = await credits.balance(req.user.id);
    const { transactions, total } = await credits.history(bearer(req), { limit, offset });
    res.json({
      balance,
      pricing: { signupCredits: SIGNUP_CREDITS, leadsPerCredit: LEADS_PER_CREDIT, jobRunCreditsPerForum: 1 },
      transactions,
      count: transactions.length,
      total,
      limit,
      offset,
    });
  });

  return router;
}
